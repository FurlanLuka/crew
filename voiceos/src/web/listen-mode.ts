import {
	type ClientMessage,
	isListenMode,
	type ListenMode,
	type ListeningMode,
} from '../shared/protocol.js';

const LISTEN_MODE_STORAGE_KEY = 'voiceos.listenMode';
// Before the modes there was only a hands-free switch, stored as '1'.
const OLD_HANDS_FREE_STORAGE_KEY = 'voiceos.handsFree';

interface ListenModeStorage {
	getItem: (key: string) => string | null;
}

// Per tab: a second tab must not start listening on its own when it opens.
export const readStoredListenMode = (storage: ListenModeStorage): ListenMode => {
	const stored = storage.getItem(LISTEN_MODE_STORAGE_KEY);

	if (isListenMode(stored)) {
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
	mode: ListenMode;
	isAwake: boolean;
}

// What the input says in each mode: what to do next, and in on-demand whether it is hearing you.
export const describeListening = ({ mode, isAwake }: DescribeListeningParams): string => {
	switch (mode) {
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
