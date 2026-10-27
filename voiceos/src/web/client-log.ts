// The page's own facts into Voice OS's log (crew server logs --cat=client): what the mic did on a
// phone nobody can open devtools on. Sent over the open socket, dropped when there is none — a log
// line is never worth a queue.
import type { ClientLogLevel, ClientMessage } from '../shared/protocol.js';

type Send = (message: ClientMessage) => void;

let sink: Send | null = null;

// The connection hands its send over once; null when the page leaves.
export const setClientLogSink = (send: Send | null): void => {
	sink = send;
};

export const clientLog = (
	level: ClientLogLevel,
	cat: string,
	msg: string,
	fields?: Record<string, unknown>,
): void => {
	sink?.({ type: 'client_log', level, cat, msg, ...(fields ? { fields } : {}) });
};

// An error as the log wants it: its name and message, never a stack.
export const describeError = (error: unknown): Record<string, string> =>
	error instanceof Error
		? { name: error.name, message: error.message }
		: { name: 'unknown', message: String(error) };

const readStandalone = (): boolean => {
	try {
		return (
			window.matchMedia('(display-mode: standalone)').matches ||
			(navigator as Navigator & { standalone?: boolean }).standalone === true
		);
	} catch {
		return false;
	}
};

// iOS has no permissions.query for the microphone: "unknown" then, never a throw.
const readMicPermission = async (): Promise<string> => {
	try {
		const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });

		return permission.state;
	} catch {
		return 'unknown';
	}
};

// Once per page load: what decides whether a mic can open here at all.
export const logPageFacts = async (): Promise<void> => {
	clientLog('info', 'mic', 'page facts', {
		isSecureContext: window.isSecureContext,
		hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
		isStandalone: readStandalone(),
		userAgent: navigator.userAgent,
		permission: await readMicPermission(),
	});
};
