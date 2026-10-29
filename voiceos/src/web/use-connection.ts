import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	Action,
	ClientMessage,
	ServerMessage,
	SpeechMessage,
	State,
} from '../shared/protocol.js';
import { reduce } from '../state/reducer.js';
import { logPageFacts, setClientLogSink } from './client-log.js';
import {
	type MainClient,
	markReloadByPage,
	readMainState,
	readTabId,
	renewTabId,
	rememberMain,
	shouldReclaim,
} from './main-screen.js';
import type { ListenCommand } from './types.js';

export type ConnectionStatus = 'connecting' | 'open' | 'unauthorized' | 'closed';

export interface AppliedServerMessage {
	state: State | null;
	shouldResync: boolean;
	// This tab's code cannot apply what the server sent: it predates the server's build.
	shouldReload?: true;
}

const OUTBOX_MESSAGES_KEPT = 20;
// This tab's id for the main screen, read once per load; replaced only when the server says another
// live page holds it (tab_taken).
let tabId = typeof window === 'undefined' ? '' : readTabId();
const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 8000;
const RELOAD_KEY = 'voiceos-reloaded-at';
// A reload that fetched the same stale code would loop; after one, fall back to resyncing.
const RELOAD_GAP_MS = 60_000;

interface ShouldReloadNowParams {
	lastReloadAt: number | null;
	now: number;
}

export const shouldReloadNow = ({ lastReloadAt, now }: ShouldReloadNowParams): boolean => {
	return lastReloadAt === null || now - lastReloadAt > RELOAD_GAP_MS;
};

export const shouldKeepWhileOffline = (message: ClientMessage): boolean => {
	// Clicks and typing are sent on reconnect; push-to-talk and playback reports are moment-bound.
	return message.type === 'action' || message.type === 'utterance';
};

// knownServerId: the server this tab's page came from, once seen.
export const applyServerMessage = (
	state: State | null,
	message: ServerMessage,
	knownServerId: string | null = null,
): AppliedServerMessage => {
	if (message.type === 'snapshot') {
		// Reconnected to a restarted Voice OS: its page may be newer than this tab's.
		const isRestarted =
			knownServerId !== null &&
			message.serverId !== undefined &&
			message.serverId !== knownServerId;

		return {
			state: message.state,
			shouldResync: false,
			...(isRestarted ? { shouldReload: true as const } : {}),
		};
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

	try {
		return { state: reduce(state, message.stamped).state, shouldResync: false };
	} catch (error) {
		// Unknown to this tab's code, or a bug in it: either way a fresh snapshot on the same code fails again.
		console.warn('input not applied', message.stamped.input.type, error);

		return { state, shouldResync: true, shouldReload: true };
	}
};

const reloadIfNotRecent = (): boolean => {
	const lastReloadAt = Number(sessionStorage.getItem(RELOAD_KEY)) || null;
	const now = Date.now();

	if (!shouldReloadNow({ lastReloadAt, now })) {
		console.warn('reloaded under a minute ago: resyncing instead');

		return false;
	}

	console.warn('reloading: this tab runs older code than the server');
	sessionStorage.setItem(RELOAD_KEY, String(now));
	markReloadByPage();
	location.reload();

	return true;
};

export const useConnection = (onSpeech: (message: SpeechMessage) => void) => {
	const [state, setState] = useState<State | null>(null);
	const [status, setStatus] = useState<ConnectionStatus>('connecting');
	const socket = useRef<WebSocket | null>(null);
	const outbox = useRef<ClientMessage[]>([]);
	const stateRef = useRef<State | null>(null);
	const serverIdRef = useRef<string | null>(null);
	const [listenCommand, setListenCommand] = useState<ListenCommand | null>(null);
	// On demand: "Voice OS" was heard and the words are going to it; ignoredAt: speech left alone.
	const [isAwake, setIsAwake] = useState(false);
	const [ignoredAt, setIgnoredAt] = useState(0);
	// A fresh object each time, so asking twice opens it twice.
	const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
	// A dictation with nowhere to go, back for the input: a fresh object each time.
	const [keptDictation, setKeptDictation] = useState<KeptDictation | null>(null);
	const speechRef = useRef(onSpeech);
	speechRef.current = onSpeech;
	// null until the server first says who has the main screen.
	const [main, setMain] = useState<MainClient | null>(null);

	useEffect(() => {
		const lifetime = new AbortController();
		// Backs off across reconnects and resets once a socket opens.
		let retryDelayMs = FIRST_RETRY_MS;
		let isFirstOpen = true;

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
				// On every connection, first: the server knows this tab by it, across dropped sockets.
				webSocket.send(JSON.stringify({ type: 'hello_tab', tabId } satisfies ClientMessage));

				for (const message of outbox.current.splice(0)) {
					webSocket.send(JSON.stringify(message));
				}

				if (isFirstOpen) {
					isFirstOpen = false;
					void logPageFacts();
				}
			};

			webSocket.onmessage = (event) => {
				const message = JSON.parse(String(event.data)) as ServerMessage;

				if (message.type === 'audio' || message.type === 'audio_cancel') {
					speechRef.current(message);

					return;
				}

				if (message.type === 'open_url') {
					setOpenRequest({ url: message.url, title: message.title });

					return;
				}

				// A fresh object each time, so saying it twice switches it twice.
				if (message.type === 'listen_off' || message.type === 'listen_on') {
					setListenCommand({ mode: message.type === 'listen_on' ? message.mode : 'push' });
					setIsAwake(false);

					return;
				}

				// A duplicated tab: a new id of its own, said at once; it is not main, so the claim its
				// load sent was dropped by the server.
				if (message.type === 'tab_taken') {
					tabId = renewTabId();
					webSocket.send(JSON.stringify({ type: 'hello_tab', tabId } satisfies ClientMessage));
					// mainState is read from tabId: a fresh object re-renders with the new id.
					setMain((current) => (current ? { ...current } : current));

					return;
				}

				if (message.type === 'main_client') {
					const next = { tabId: message.tabId, device: message.device };
					const wasMain = rememberMain(next, tabId);
					setMain(next);

					// The server restarted and knows no main: only the tab that held it takes it back;
					// every other tab stays as it was.
					if (shouldReclaim(next, wasMain)) {
						webSocket.send(JSON.stringify({ type: 'claim_main' } satisfies ClientMessage));
					}

					return;
				}

				if (message.type === 'listen_state') {
					setIsAwake(message.isAwake);

					return;
				}

				if (message.type === 'dictation_kept') {
					setKeptDictation({ text: message.text, reason: message.reason });

					return;
				}

				if (message.type === 'heard_ignored') {
					setIgnoredAt(Date.now());

					return;
				}

				const {
					state: nextState,
					shouldResync,
					shouldReload,
				} = applyServerMessage(stateRef.current, message, serverIdRef.current);

				if (shouldReload && reloadIfNotRecent()) {
					return;
				}

				if (message.type === 'snapshot' && message.serverId) {
					serverIdRef.current = message.serverId;
				}

				if (shouldResync) {
					webSocket.close();

					return;
				}

				stateRef.current = nextState;
				setState(nextState);
			};

			webSocket.onclose = () => {
				// A call open on the old socket is not open on the next: no false chime on reconnect.
				setIsAwake(false);
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

	useEffect(() => {
		setClientLogSink(send);

		return () => setClientLogSink(null);
	}, [send]);

	const claimMain = useCallback(() => send({ type: 'claim_main' }), [send]);

	const sendBinary = useCallback((chunk: ArrayBuffer) => {
		if (socket.current?.readyState === WebSocket.OPEN) {
			socket.current.send(chunk);
		}
	}, []);

	return {
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
		mainState: readMainState(main, tabId),
		mainDevice: main?.device ?? '',
		claimMain,
	};
};

// Who has the main screen: the one that listens and speaks. Unknown until the server says.
export interface KeptDictation {
	text: string;
	reason: string;
}

export interface OpenRequest {
	url: string;
	title: string;
}
