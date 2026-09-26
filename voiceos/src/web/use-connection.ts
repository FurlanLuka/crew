import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	Action,
	ClientMessage,
	ServerMessage,
	SpeechMessage,
	State,
} from '../shared/protocol.js';
import { reduce } from '../state/reducer.js';
import type { ListenOff } from './types.js';

export type ConnectionStatus = 'connecting' | 'open' | 'unauthorized' | 'closed';

export interface AppliedServerMessage {
	state: State | null;
	shouldResync: boolean;
}

const OUTBOX_MESSAGES_KEPT = 20;
const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 8000;

export const shouldKeepWhileOffline = (message: ClientMessage): boolean => {
	// Clicks and typing are sent on reconnect; push-to-talk and playback reports are moment-bound.
	return message.type === 'action' || message.type === 'utterance';
};

export const applyServerMessage = (
	state: State | null,
	message: ServerMessage,
): AppliedServerMessage => {
	if (message.type === 'snapshot') {
		return { state: message.state, shouldResync: false };
	}

	if (message.type !== 'input' || !state) {
		return { state, shouldResync: false };
	}

	if (message.stamped.seq <= state.seq) {
		return { state, shouldResync: false };
	}

	// A gap in seq means an input was missed: reopen for a fresh snapshot rather than guess.
	if (message.stamped.seq !== state.seq + 1) {
		return { state, shouldResync: true };
	}

	return { state: reduce(state, message.stamped).state, shouldResync: false };
};

export const useConnection = (onSpeech: (message: SpeechMessage) => void) => {
	const [state, setState] = useState<State | null>(null);
	const [status, setStatus] = useState<ConnectionStatus>('connecting');
	const socket = useRef<WebSocket | null>(null);
	const outbox = useRef<ClientMessage[]>([]);
	const stateRef = useRef<State | null>(null);
	// The server turned hands-free off for this tab; a new object each time, so every one is noticed.
	const [listenOff, setListenOff] = useState<ListenOff | null>(null);
	const speechRef = useRef(onSpeech);
	speechRef.current = onSpeech;

	useEffect(() => {
		const lifetime = new AbortController();
		// Backs off across reconnects and resets once a socket opens.
		let retryDelayMs = FIRST_RETRY_MS;

		const connect = () => {
			if (lifetime.signal.aborted) {
				return;
			}

			setStatus('connecting');
			const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
			const webSocket = new WebSocket(`${scheme}://${location.host}/ws`);
			webSocket.binaryType = 'arraybuffer';
			socket.current = webSocket;
			// Set on open: a socket that never opened was refused, not dropped.
			let hasOpened = false;

			const scheduleReconnect = () => {
				setStatus('closed');
				setTimeout(connect, retryDelayMs);
			};

			webSocket.onopen = () => {
				hasOpened = true;
				retryDelayMs = FIRST_RETRY_MS;
				setStatus('open');

				for (const message of outbox.current.splice(0)) {
					webSocket.send(JSON.stringify(message));
				}
			};

			webSocket.onmessage = (event) => {
				const message = JSON.parse(String(event.data)) as ServerMessage;

				if (message.type === 'audio' || message.type === 'audio_cancel') {
					speechRef.current(message);

					return;
				}

				if (message.type === 'listen_off') {
					setListenOff({ reason: message.reason });

					return;
				}

				const { state: nextState, shouldResync } = applyServerMessage(stateRef.current, message);

				if (shouldResync) {
					webSocket.close();

					return;
				}

				stateRef.current = nextState;
				setState(nextState);
			};

			webSocket.onclose = () => {
				socket.current = null;

				if (lifetime.signal.aborted) {
					return;
				}

				retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);

				if (hasOpened) {
					scheduleReconnect();

					return;
				}

				// A refused upgrade: without the cookie, retrying cannot help until the link is reopened.
				fetch('/whoami')
					.then((response) => {
						if (response.status === 401) {
							setStatus('unauthorized');

							return;
						}

						scheduleReconnect();
					})
					.catch(() => {
						scheduleReconnect();
					});
			};
		};

		connect();

		return () => {
			lifetime.abort();
			socket.current?.close();
		};
	}, []);

	const send = useCallback((message: ClientMessage) => {
		if (socket.current?.readyState === WebSocket.OPEN) {
			socket.current.send(JSON.stringify(message));

			return;
		}

		if (shouldKeepWhileOffline(message)) {
			outbox.current = [...outbox.current, message].slice(-OUTBOX_MESSAGES_KEPT);
		}
	}, []);

	const dispatch = useCallback((action: Action) => send({ type: 'action', action }), [send]);

	const sendBinary = useCallback((chunk: ArrayBuffer) => {
		if (socket.current?.readyState === WebSocket.OPEN) {
			socket.current.send(chunk);
		}
	}, []);

	return { state, status, send, dispatch, sendBinary, listenOff };
};
