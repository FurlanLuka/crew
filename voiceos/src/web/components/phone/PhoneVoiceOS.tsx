// Voice OS on a phone: the same state, components and tokens as the desktop, arranged for a narrow
// touch screen — Home as one card per session, a top bar with back, the name and ⋯ instead of the tab strip, a session that is only
// its conversation, and one bar for every listening mode. The view is still the server's, shared with
// every tab: words said here go to the session on screen. ⋯ is this page's alone.
import { type ReactNode, useState } from 'react';
import type { ClientMessage, State } from '../../../shared/protocol.js';
import type { Dispatch } from '../../types.js';
import type { KeptDictation } from '../../use-connection.js';
import type { VoiceInput } from '../../use-voice-input.js';
import { Activate } from '../Activate.js';
import { Settings } from '../Settings.js';
import { InstallGuide } from './InstallGuide.js';
import { PhoneBar } from './PhoneBar.js';
import { PhoneHome } from './PhoneHome.js';
import { PhoneSession } from './PhoneSession.js';
import { PhoneTopBar } from './PhoneTopBar.js';

interface PhoneVoiceOSProps {
	state: State;
	dispatch: Dispatch;
	send: (message: ClientMessage) => void;
	voice: VoiceInput;
	isAwake: boolean;
	keptDictation: KeptDictation | null;
	// Voice OS's notices (connection, a held-back link, the mic, keys): the same on every layout.
	notices: ReactNode;
	// A phone's link opened in the browser: the install guide, until it is saved or waved away.
	isInstallShown: boolean;
	onInstallDismissed: () => void;
	onNewSession: (machine?: string) => void;
	onSetUp: (machine: string) => void;
}

export const PhoneVoiceOS = ({
	state,
	dispatch,
	send,
	voice,
	isAwake,
	keptDictation,
	notices,
	isInstallShown,
	onInstallDismissed,
	onNewSession,
	onSetUp,
}: PhoneVoiceOSProps) => {
	// The session ⋯ was opened on: another session on screen closes it.
	const [moreFor, setMoreFor] = useState<string | null>(null);
	const { view } = state;
	const session = view.kind === 'session' ? state.sessions[view.ref] : undefined;

	if (isInstallShown) {
		return (
			<div className="vo phone">
				<InstallGuide onDismiss={onInstallDismissed} />
			</div>
		);
	}

	return (
		<div className="vo phone">
			<PhoneTopBar
				state={state}
				dispatch={dispatch}
				onNewSession={() => onNewSession()}
				onMore={() => setMoreFor(session?.ref ?? null)}
			/>
			<main className={`vo-main ${session ? 'in-session' : ''}`}>
				{notices}
				{session ? (
					<PhoneSession
						key={session.ref}
						session={session}
						state={state}
						dispatch={dispatch}
						send={send}
						isMoreOpen={moreFor === session.ref}
						onCloseMore={() => setMoreFor(null)}
					/>
				) : view.kind === 'activate' ? (
					<Activate
						key={view.machine ?? 'all'}
						state={state}
						dispatch={dispatch}
						{...(view.machine ? { machine: view.machine } : {})}
						onNewSession={onNewSession}
						onSetUpMachine={onSetUp}
					/>
				) : view.kind === 'settings' ? (
					<Settings
						state={state}
						dispatch={dispatch}
						listenMode={voice.listenMode}
						onListenMode={voice.chooseMode}
						onSetUpMachine={onSetUp}
					/>
				) : (
					<PhoneHome state={state} dispatch={dispatch} />
				)}
			</main>
			<PhoneBar
				state={state}
				voice={voice}
				isAwake={isAwake}
				keptDictation={keptDictation}
				send={send}
			/>
		</div>
	);
};
