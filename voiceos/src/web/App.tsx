import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LOCAL_MACHINE } from '../shared/machine-ref.js';
import { Card } from './components/Card.js';
import { ConnectionBanner } from './components/ConnectionBanner.js';
import { VoiceOS } from './components/VoiceOS.js';
import { Home } from './home/Home.js';
import { Opening, isReducedMotion } from './home/Opening.js';
import { type Half, readAlwaysVoice, shouldOpenVoice, writeLastHalf } from './home/prefs.js';
import { VoiceMoment } from './home/VoiceMoment.js';
import { BOARD, matchRoute, toView, toVoiceRoute, useRoute, viewKey } from './router.js';
import { SetupShell } from './setup/SetupShell.js';
import { useConnection, type OpenRequest } from './use-connection.js';
import { useSpeechPlayer } from './use-speech-player.js';

// "Open the doc" by voice: a new tab when the browser allows it; a phone, or any browser that
// wants a tap first, gets a banner to tap instead.
const useOpenRequest = (request: OpenRequest | null): OpenRequest | null => {
	const [blocked, setBlocked] = useState<OpenRequest | null>(null);

	useEffect(() => {
		if (!request) {
			return;
		}

		const opened = window.open(request.url, '_blank');

		if (opened) {
			opened.opener = null;
		}

		setBlocked(opened ? null : request);
	}, [request]);

	return blocked;
};

// Read once: a fresh load of / is the only place the opening plays and "Always open Voice OS" applies.
const FIRST_ROUTE = matchRoute(location.pathname, location.search);
const isFreshHome = FIRST_ROUTE.half === 'home';

const App = () => {
	const { route, navigate } = useRoute();
	const player = useSpeechPlayer();
	const {
		state,
		status,
		send,
		dispatch,
		sendBinary,
		listenCommand,
		isAwake,
		ignoredAt,
		openRequest,
		keptDictation,
	} = useConnection((message) => player.receive(message));
	const [isMoment, setIsMoment] = useState(false);
	const blockedOpen = useOpenRequest(openRequest);
	const viewNow = state ? viewKey(state.view) : null;
	const lastPushed = useRef<string | null>(null);

	// Demos and screenshots: window.voiceos.say("…") is heard like speech. The server ignores it
	// unless it runs with VOICEOS_DEBUG_SPEECH=1.
	useEffect(() => {
		const debug = {
			say: (text: string, holdMs?: number) => send({ type: 'simulate_speech', text, holdMs }),
		};

		Object.assign(window, { voiceos: debug });

		return () => {
			Reflect.deleteProperty(window, 'voiceos');
		};
	}, [send]);

	// A Voice OS address the developer opened (a link, a reload, back): the server's view follows it.
	// Bare /voice names no screen: it shows whatever every tab is showing.
	const routeViewKey = route.half === 'voice' ? viewKey(route.view) : null;

	useEffect(() => {
		if (route.half !== 'voice' || !state || routeViewKey === null) {
			return;
		}

		if (routeViewKey === viewKey(state.view)) {
			return;
		}

		if (route.view.kind === 'active') {
			navigate({ half: 'voice', view: toVoiceRoute(state.view) }, { replace: true });

			return;
		}

		if (lastPushed.current !== routeViewKey) {
			lastPushed.current = routeViewKey;
			dispatch({ type: 'switch_view', view: toView(route.view) });
		}
		// Only when the address changes, or the first state arrives.
	}, [routeViewKey, state === null]);

	// The server's view moved (a click, a voice command, another tab): the address follows it.
	useEffect(() => {
		if (route.half !== 'voice' || !state || viewNow === null) {
			return;
		}

		lastPushed.current = null;

		if (viewNow !== routeViewKey) {
			navigate({ half: 'voice', view: toVoiceRoute(state.view) }, { replace: true });
		}
	}, [viewNow]);

	const goHome = useCallback(() => navigate({ half: 'home' }), [navigate]);

	// Only the first Home of a fresh load of / may be replaced: the crew mark always shows Home.
	const isFreshLoad = useRef(isFreshHome);
	const openVoiceIfAlways = useCallback(
		(isFirstRun: boolean) => {
			const isFresh = isFreshLoad.current;

			isFreshLoad.current = false;

			if (
				state &&
				shouldOpenVoice({ isFreshHome: isFresh, isAlwaysVoice: readAlwaysVoice(), isFirstRun })
			) {
				navigate({ half: 'voice', view: toVoiceRoute(state.view) }, { replace: true });
			}
		},
		[navigate, state],
	);

	const pick = useCallback(
		(half: Half) => {
			writeLastHalf(half);

			if (half === 'setup') {
				navigate({ half: 'setup', machine: LOCAL_MACHINE, page: BOARD });

				return;
			}

			if (!isReducedMotion()) {
				setIsMoment(true);
			}

			navigate({ half: 'voice', view: state ? toVoiceRoute(state.view) : { kind: 'active' } });
		},
		[navigate, state],
	);

	const openSetup = useCallback(
		(machine: string, project?: string) =>
			navigate({
				half: 'setup',
				machine,
				page: project ? { page: 'project', name: project } : { page: 'machine' },
			}),
		[navigate],
	);

	// Activated and shown in one input (no switch offer from a click): a worktree crew made moments
	// ago that Voice OS has not listed yet is held until it has, then opened. The address follows
	// the view.
	const openVoice = (ref: string) => {
		dispatch({ type: 'activate', ref, open: true });
		navigate({ half: 'voice', view: { kind: 'session', ref } });
	};

	if (status === 'unauthorized') {
		return (
			<Card title="Open crew from a terminal">
				<p>
					This browser has no crew session. Run <code>crew</code> in a terminal and open the link it
					prints.
				</p>
			</Card>
		);
	}

	if (!state) {
		return (
			<Card title="Connecting…">
				<p>Waiting for crew's server.</p>
			</Card>
		);
	}

	return (
		<>
			{route.half === 'home' && <Home state={state} onPick={pick} onStage={openVoiceIfAlways} />}
			{route.half === 'voice' && (
				<VoiceOS
					state={state}
					isConnected={status === 'open'}
					connectionStatus={status}
					send={send}
					sendBinary={sendBinary}
					listenCommand={listenCommand}
					isAwake={isAwake}
					ignoredAt={ignoredAt}
					keptDictation={keptDictation}
					blockedOpen={blockedOpen}
					player={player}
					onHome={goHome}
					onSetUp={openSetup}
				/>
			)}
			{route.half === 'setup' && (
				<SetupShell
					state={state}
					route={route}
					navigate={navigate}
					send={send}
					openVoice={openVoice}
				/>
			)}
			{route.half !== 'voice' && <ConnectionBanner status={status} />}
			{route.half === 'home' && isFreshHome && <Opening />}
			{isMoment && <VoiceMoment onDone={() => setIsMoment(false)} />}
		</>
	);
};

const root = document.getElementById('root');

if (root) {
	createRoot(root).render(<App />);
}
