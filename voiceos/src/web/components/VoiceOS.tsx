// Voice OS, the workhorse: the docked top bar, one view (Home, a session, a machine's page,
// Settings), the docked voice bar and the New session dialog. The view is the server's (every tab
// shows the same); the URL follows it.
import { useEffect, useRef, useState } from 'react';
import { readOpenGroup } from '../../shared/groups.js';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { parentView } from '../../shared/machines.js';
import type { ClientMessage, State } from '../../shared/protocol.js';
import { isInDialog } from '../in-dialog.js';
import type { Dispatch, ListenCommand, MicStatus } from '../types.js';
import { type MainState, wasReloadedByPage, wasTabRenewed } from '../main-screen.js';
import type { ConnectionStatus, KeptDictation, OpenRequest } from '../use-connection.js';
import type { PcmPlayer } from '../use-speech-player.js';
import { IS_PHONE, IS_PHONE_LINK, shouldShowInstall } from '../phone.js';
import { useVoiceInput } from '../use-voice-input.js';
import { Activate } from './Activate.js';
import { ActiveView } from './ActiveView.js';
import { BeforeYouTalk, listMissingKeys } from './BeforeYouTalk.js';
import { BottomBar } from './BottomBar.js';
import { ConnectionBanner } from './ConnectionBanner.js';
import { Cockpit } from './Cockpit.js';
import { MainElsewhere } from './MainElsewhere.js';
import { NewSessionDialog } from './NewSessionDialog.js';
import { isStandalone, readInstallDismissed } from './phone/InstallGuide.js';
import { PhoneVoiceOS } from './phone/PhoneVoiceOS.js';
import { Settings } from './Settings.js';
import { TopBar } from './TopBar.js';

const IGNORED_DOT_MS = 900;

// Once per page load: Voice OS opened here takes the main screen. A reconnect (a tab waking up), the
// reload a restarted server causes, and a page that only shows Home or Set up never do.
let hasClaimedMain = typeof window !== 'undefined' && wasReloadedByPage();

// How long a New session line stays in the notices.
const NEW_SESSION_LINE_MS = 5000;

interface VoiceOSProps {
	state: State;
	isConnected: boolean;
	connectionStatus: ConnectionStatus;
	send: (message: ClientMessage) => void;
	sendBinary: (chunk: ArrayBuffer) => void;
	listenCommand: ListenCommand | null;
	isAwake: boolean;
	ignoredAt: number;
	keptDictation: KeptDictation | null;
	blockedOpen: OpenRequest | null;
	player: PcmPlayer;
	// Whether this page listens and speaks: only the main screen does.
	mainState: MainState;
	mainDevice: string;
	onClaimMain: () => void;
	onHome: () => void;
	onSetUp: (machine: string) => void;
}

// "Before you talk": "Not now" holds for the tab, through a reconnect and the reload a server
// restart brings; the notice above keeps the way back to the sheet.
const KEY_SHEET_DISMISSED_KEY = 'voiceos.keySheetDismissed';

const readKeySheetDismissed = (): boolean => {
	try {
		return sessionStorage.getItem(KEY_SHEET_DISMISSED_KEY) === '1';
	} catch {
		return false;
	}
};

const writeKeySheetDismissed = (): void => {
	try {
		sessionStorage.setItem(KEY_SHEET_DISMISSED_KEY, '1');
	} catch {
		// Private mode or blocked storage: the sheet comes back on the next load.
	}
};

export const VoiceOS = ({
	state,
	isConnected,
	connectionStatus,
	send,
	sendBinary,
	listenCommand,
	isAwake,
	ignoredAt,
	keptDictation,
	blockedOpen,
	player,
	mainState,
	mainDevice,
	onClaimMain,
	onHome,
	onSetUp,
}: VoiceOSProps) => {
	const [micStatus, setMicStatus] = useState<MicStatus>('idle');
	// The New session dialog: the machine it opens on, or null while it is closed.
	const [newSessionOn, setNewSessionOn] = useState<string | null>(null);
	// What the last one left: "Started research on Build box.", for a moment.
	const [newSessionLine, setNewSessionLine] = useState<string | null>(null);
	const newSessionOpener = useRef<HTMLElement | null>(null);

	// "Started research on Build box." is news for a moment, then the tab up top says the rest.
	useEffect(() => {
		if (!newSessionLine) {
			return;
		}

		const timer = setTimeout(() => setNewSessionLine(null), NEW_SESSION_LINE_MS);

		return () => clearTimeout(timer);
	}, [newSessionLine]);
	const [isIgnored, setIsIgnored] = useState(false);
	const missingKeys = listMissingKeys(state);
	const [isSheetOpen, setIsSheetOpen] = useState(
		() => missingKeys.length > 0 && !readKeySheetDismissed(),
	);
	// The install guide comes first on a phone's link in the browser: the keys can wait for the saved app.
	const [isInstallShown, setIsInstallShown] = useState(() =>
		shouldShowInstall({
			isPhoneLink: IS_PHONE_LINK,
			isStandalone: isStandalone(),
			isDismissed: readInstallDismissed(),
		}),
	);
	const stateRef = useRef(state);
	stateRef.current = state;
	const dispatch: Dispatch = (action) => send({ type: 'action', action });
	const voice = useVoiceInput({
		state,
		isConnected,
		listenCommand,
		send,
		sendBinary,
		player,
		micStatus,
		onMicStatusChange: setMicStatus,
		isMain: mainState === 'here',
	});

	useEffect(() => {
		if (isConnected && !hasClaimedMain) {
			hasClaimedMain = true;

			// A duplicated tab told tab_taken before this ran: the original keeps the main screen.
			if (!wasTabRenewed()) {
				onClaimMain();
			}
		}
	}, [isConnected, onClaimMain]);

	// Speech without "Voice OS" was heard and left alone: a brief dot, so the mic is seen to work.
	useEffect(() => {
		if (!ignoredAt) {
			return;
		}

		setIsIgnored(true);
		const timer = setTimeout(() => setIsIgnored(false), IGNORED_DOT_MS);

		return () => clearTimeout(timer);
	}, [ignoredAt]);

	// The call is heard: a chime, as a press would give the feeling of.
	useEffect(() => {
		if (isAwake) {
			player.playChime();
		}
	}, [isAwake, player]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			const isInField =
				event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

			// A dialog's own Esc closes the dialog only, and a menu's closes the menu.
			if (event.key === 'Escape' && !isInField && !isInDialog(event) && !event.defaultPrevented) {
				// An open group the bar shows closes first: it is the level the bar is on.
				// Then up one level: a session → Home (or the machine's page it came from).
				send({
					type: 'action',
					action: readOpenGroup(stateRef.current)
						? { type: 'open_group', id: null }
						: { type: 'switch_view', view: parentView(stateRef.current) },
				});
			}
		};

		window.addEventListener('keydown', handleKeyDown);

		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [send]);

	const { view } = state;
	const session = view.kind === 'session' ? state.sessions[view.ref] : undefined;

	// From the top bar or Home: the machine on screen, else this Mac.
	const openNewSession = (machine?: string) => {
		// Focus goes back where it was once the dialog closes; a menu item that opened it is gone by then.
		const opener = document.activeElement;
		newSessionOpener.current =
			opener instanceof HTMLElement && !opener.closest('[role="menu"]')
				? opener
				: document.querySelector<HTMLElement>('.vo-new');
		setNewSessionLine(null);
		setNewSessionOn(
			machine ?? (view.kind === 'activate' ? view.machine : undefined) ?? LOCAL_MACHINE,
		);
	};

	const notices = (
		<div className="vo-notices">
			<ConnectionBanner status={connectionStatus} isInline />
			{blockedOpen && (
				<div className="vo-notice">
					<a href={blockedOpen.url} target="_blank" rel="noopener noreferrer">
						Open {blockedOpen.title} ↗
					</a>{' '}
					— the browser held back opening it for you.
				</div>
			)}
			{mainState === 'none' && (
				<div className="vo-notice" role="status">
					Voice is on no screen right now.{' '}
					<button type="button" className="linkish" onClick={onClaimMain}>
						Use it here
					</button>
				</div>
			)}
			{newSessionLine && (
				<div className="vo-notice" role="status">
					{newSessionLine}
				</div>
			)}
			{/* A phone says it on its bar, with where this phone keeps the switch. */}
			{micStatus === 'denied' && !IS_PHONE && (
				<div className="vo-notice">
					Microphone blocked. Allow it in the browser's site settings, or type below.
				</div>
			)}
			{!isSheetOpen && missingKeys.length > 0 && (
				<div className="vo-notice">
					Voice is off until its keys are set: {missingKeys.join(' and ')}.{' '}
					<button type="button" className="linkish" onClick={() => setIsSheetOpen(true)}>
						Add them
					</button>{' '}
					· Text and clicks still work.
				</div>
			)}
		</div>
	);

	const dialogs = (
		<>
			{mainState === 'elsewhere' && <MainElsewhere device={mainDevice} onUseHere={onClaimMain} />}
			{newSessionOn !== null && (
				<NewSessionDialog
					state={state}
					machine={newSessionOn}
					dispatch={dispatch}
					onClose={(line) => {
						setNewSessionOn(null);
						setNewSessionLine(line || null);
						newSessionOpener.current?.focus();
					}}
				/>
			)}
			{isSheetOpen && missingKeys.length > 0 && !isInstallShown && (
				<BeforeYouTalk
					state={state}
					onClose={() => setIsSheetOpen(false)}
					onNotNow={() => {
						// Stays in Voice OS: text and clicks work without the keys, and the notice above
						// keeps the way back to this sheet.
						writeKeySheetDismissed();
						setIsSheetOpen(false);
					}}
				/>
			)}
		</>
	);

	if (IS_PHONE) {
		return (
			<>
				<PhoneVoiceOS
					state={state}
					dispatch={dispatch}
					send={send}
					voice={voice}
					isAwake={isAwake && isConnected}
					keptDictation={keptDictation}
					notices={notices}
					isInstallShown={isInstallShown}
					onInstallDismissed={() => setIsInstallShown(false)}
					onNewSession={openNewSession}
					onSetUp={onSetUp}
				/>
				{dialogs}
			</>
		);
	}

	return (
		<div className="vo">
			<TopBar
				state={state}
				dispatch={dispatch}
				onHome={onHome}
				onNewSession={() => openNewSession()}
			/>
			<main className={`vo-main ${session ? 'in-session' : ''}`}>
				{notices}
				{session ? (
					<Cockpit key={session.ref} session={session} state={state} dispatch={dispatch} />
				) : view.kind === 'activate' ? (
					<Activate
						key={view.machine ?? 'all'}
						state={state}
						dispatch={dispatch}
						{...(view.machine ? { machine: view.machine } : {})}
						onNewSession={openNewSession}
						onSetUpMachine={onSetUp}
					/>
				) : view.kind === 'settings' ? (
					<Settings
						state={state}
						dispatch={dispatch}
						listenMode={voice.listenMode}
						onListenMode={voice.chooseMode}
						onSetUpMachine={(machine) => onSetUp(machine)}
					/>
				) : (
					<ActiveView state={state} dispatch={dispatch} onNewSession={() => openNewSession()} />
				)}
			</main>
			<BottomBar
				state={state}
				voice={voice}
				isAwake={isAwake && isConnected}
				isIgnored={isIgnored}
				keptDictation={keptDictation}
				send={send}
			/>
			{dialogs}
		</div>
	);
};
