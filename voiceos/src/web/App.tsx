import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isInDialog } from './in-dialog.js';
import { BottomBar } from './components/BottomBar.js';
import { Card } from './components/Card.js';
import { Dock } from './components/Dock.js';
import { Main } from './components/Main.js';
import { QueueList } from './components/QueueList.js';
import { LastSpokenLine } from './components/LastSpokenLine.js';
import { Tabs } from './components/Tabs.js';
import { TopBar } from './components/TopBar.js';
import type { MicStatus } from './types.js';
import { useConnection, type OpenRequest } from './use-connection.js';
import { useSpeechPlayer } from './use-speech-player.js';
import { parentView } from '../shared/machines.js';

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

const App = () => {
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
	const [micStatus, setMicStatus] = useState<MicStatus>('idle');
	const stateRef = useRef(state);

	stateRef.current = state;
	const blockedOpen = useOpenRequest(openRequest);

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

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// A dialog's own Esc closes the dialog only.
			if (
				event.key === 'Escape' &&
				!(event.target instanceof HTMLInputElement) &&
				!isInDialog(event)
			) {
				// Up one level: a session → its machine → Mission Control.
				if (stateRef.current) {
					dispatch({ type: 'switch_view', view: parentView(stateRef.current) });
				}
			}
		};

		window.addEventListener('keydown', handleKeyDown);

		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [dispatch]);

	if (status === 'unauthorized') {
		return (
			<Card title="Open Voice OS from crew">
				<p>
					This browser has no Voice OS session. Run <code>crew voice</code> in a terminal and open
					the link it prints.
				</p>
			</Card>
		);
	}

	if (!state) {
		return (
			<Card title="Connecting…">
				<p>Waiting for the Voice OS server.</p>
			</Card>
		);
	}

	const viewedSession = state.view.kind === 'session' ? state.sessions[state.view.ref] : undefined;

	return (
		<div className="app">
			<div>
				{status !== 'open' && <div className="banner">Reconnecting to the Voice OS server…</div>}
				{state.setup.missing.length > 0 && (
					<div className="banner">
						Voice is off until these are set: {state.setup.missing.join(', ')}. Run crew voice keys
						set anthropic (or soniox) in a terminal, then crew voice restart. Text and clicks still
						work.
					</div>
				)}
				{blockedOpen && (
					<div className="banner">
						<a href={blockedOpen.url} target="_blank" rel="noopener noreferrer">
							Open {blockedOpen.title} ↗
						</a>{' '}
						— the browser held back opening it for you.
					</div>
				)}
				{micStatus === 'denied' && (
					<div className="banner">
						Microphone blocked. Allow it in the browser's site settings, or type below.
					</div>
				)}
				<TopBar state={state} dispatch={dispatch} />
			</div>
			{viewedSession ? <Tabs state={state} dispatch={dispatch} /> : <div />}
			<Main state={state} dispatch={dispatch} />
			<Dock state={state} dispatch={dispatch} />
			{viewedSession ? <QueueList session={viewedSession} dispatch={dispatch} /> : <div />}
			<LastSpokenLine state={state} />
			<BottomBar
				state={state}
				isConnected={status === 'open'}
				listenCommand={listenCommand}
				isAwake={isAwake && status === 'open'}
				ignoredAt={ignoredAt}
				keptDictation={keptDictation}
				send={send}
				sendBinary={sendBinary}
				player={player}
				micStatus={micStatus}
				onMicStatusChange={setMicStatus}
			/>
		</div>
	);
};

const root = document.getElementById('root');

if (root) {
	createRoot(root).render(<App />);
}
