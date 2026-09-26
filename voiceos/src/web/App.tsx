import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BottomBar } from './components/BottomBar.js';
import { Card } from './components/Card.js';
import { Dock } from './components/Dock.js';
import { Main } from './components/Main.js';
import { QueueList } from './components/QueueList.js';
import { LastSpokenLine } from './components/LastSpokenLine.js';
import { Tabs } from './components/Tabs.js';
import { TopBar } from './components/TopBar.js';
import type { MicStatus } from './types.js';
import { useConnection } from './use-connection.js';
import { useSpeechPlayer } from './use-speech-player.js';

const App = () => {
	const player = useSpeechPlayer();
	const { state, status, send, dispatch, sendBinary, listenOff } = useConnection((message) =>
		player.receive(message),
	);
	const [micStatus, setMicStatus] = useState<MicStatus>('idle');

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement)) {
				dispatch({ type: 'switch_view', view: { kind: 'grid' } });
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
						Voice is off until these key files exist: {state.setup.missing.join(', ')}. Text and
						clicks still work.
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
				listenOff={listenOff}
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
