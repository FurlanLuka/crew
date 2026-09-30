import {
	type ClientMessage,
	isListenMode,
	type ListenMode,
	type ListeningMode,
} from '../shared/protocol.js';

const LISTEN_MODE_STORAGE_KEY = 'voiceos.listenMode';

// How this tab takes speech: the server's listening modes, plus dictation — a press held open for a
// brain dump, which the server sees as a press and this page alone knows as a mode.
export type InputMode = ListenMode | 'dictation';

export const INPUT_MODES: InputMode[] = ['push', 'on-demand', 'hands-free', 'dictation'];

export const isInputMode = (value: unknown): value is InputMode =>
	value === 'dictation' || isListenMode(value);

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
