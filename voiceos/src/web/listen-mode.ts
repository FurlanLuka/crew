import { clientLog } from './client-log.js';
import {
	type ClientMessage,
	isListenMode,
	type ListenMode,
	type ListeningMode,
} from '../shared/protocol.js';

const LISTEN_MODE_STORAGE_KEY = 'voiceos.listenMode';

// How this tab takes speech: the server's listening modes, plus dictation — a press held open for a
// brain dump, which the server sees as a press and this page alone knows as a mode — and text, for
// where talking isn't an option: no mic, nothing played, typing only.
export type InputMode = ListenMode | 'dictation' | 'text';

export const INPUT_MODES: InputMode[] = ['push', 'on-demand', 'hands-free', 'dictation', 'text'];

export const isInputMode = (value: unknown): value is InputMode =>
	value === 'dictation' || value === 'text' || isListenMode(value);

// The server switching this tab (another tab took listening, or its stream failed) only ever ends a
// listening mode; a tab that chose text has no mic to hand back, so listen_off leaves it as it is.
export const applyListenCommand = (current: InputMode, commanded: ListenMode): InputMode =>
	current === 'text' && commanded === 'push' ? current : commanded;

// Only the listening modes keep a stream open; push and dictation open one per press.
export const isListeningMode = (mode: InputMode): mode is ListeningMode =>
	mode === 'on-demand' || mode === 'hands-free';
// Before the modes there was only a hands-free switch, stored as '1'.
const OLD_HANDS_FREE_STORAGE_KEY = 'voiceos.handsFree';

interface ListenModeStorage {
	getItem: (key: string) => string | null;
}

// Per tab: a second tab must not start listening on its own when it opens.
export const readStoredListenMode = (storage: ListenModeStorage): InputMode => {
	const stored = storage.getItem(LISTEN_MODE_STORAGE_KEY);

	if (isInputMode(stored)) {
		return stored;
	}

	return storage.getItem(OLD_HANDS_FREE_STORAGE_KEY) === '1' ? 'hands-free' : 'push';
};

export const listenModeStorageKey = LISTEN_MODE_STORAGE_KEY;

export const listenStartMessage = (mode: ListeningMode, sampleRate: number): ClientMessage => ({
	type: 'listen_start',
	sampleRate,
	mode,
});

interface DescribeListeningParams {
	mode: InputMode;
	isAwake: boolean;
	isDictating?: boolean;
}

// What the input says in each mode: what to do next, and in on-demand whether it is hearing you.
export const describeListening = ({
	mode,
	isAwake,
	isDictating = false,
}: DescribeListeningParams): string => {
	switch (mode) {
		case 'text':
			return 'Type a message…';
		case 'dictation':
			return isDictating
				? 'Dictating — take your time, pauses are fine. Send when you are done…'
				: 'Click the mic or press Space to dictate, or type here…';
		case 'push':
			return 'Hold Space to talk, or type here…';
		case 'hands-free':
			return 'Listening — just talk, or type here…';
		case 'on-demand':
			return isAwake
				? 'Listening to you — pause, or say “end of turn”…'
				: 'Say “Voice OS”, then your command — or type here…';
	}
};

// How long after Voice OS's speech ends a phone's mic still holds back: the room's echo of the last
// words.
export const ECHO_TAIL_MS = 400;

interface EchoGateParams {
	isPhone: boolean;
	mode: InputMode;
	// Voice OS's speech is playing, or ended within ECHO_TAIL_MS.
	isSpeaking: boolean;
}

// A phone's echo cancelling does not cover the page's own playback: in the always-listening modes
// it would hear Voice OS speak and take it as the developer. While it speaks, its mic sends nothing.
// Push to talk stops the speech when pressed, and a desktop keeps talking over it to interrupt.
export const isEchoGated = ({ isPhone, mode, isSpeaking }: EchoGateParams): boolean =>
	isPhone && isListeningMode(mode) && isSpeaking;

interface EchoGatedSendParams {
	isPhone: boolean;
	readMode: () => InputMode;
	// Voice OS's speech is playing, or ended within the given time.
	isAudibleWithin: (ms: number) => boolean;
	send: (chunk: ArrayBuffer) => void;
}

// The mic's audio out, held back while a phone would hear Voice OS speak; each turn of the gate goes
// to the log.
export const createEchoGatedSend = ({
	isPhone,
	readMode,
	isAudibleWithin,
	send,
}: EchoGatedSendParams): ((chunk: ArrayBuffer) => void) => {
	let wasGated = false;

	return (chunk) => {
		const mode = readMode();
		const isGated = isEchoGated({ isPhone, mode, isSpeaking: isAudibleWithin(ECHO_TAIL_MS) });

		if (isGated !== wasGated) {
			wasGated = isGated;
			clientLog('debug', 'mic', isGated ? 'echo gate on' : 'echo gate off', { mode });
		}

		if (!isGated) {
			send(chunk);
		}
	};
};
