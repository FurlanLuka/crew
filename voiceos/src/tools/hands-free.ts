import type { ListenMode } from '../shared/protocol.js';

export type HandsFreeResult = 'changed' | 'already' | 'no_tab';

// "off" is push to talk: listening stops, the key still talks.
export const toListenMode = (answer: string): ListenMode | null => {
	switch (answer) {
		case 'hands-free':
		case 'on-demand':
		case 'push':
			return answer;
		case 'off':
			return 'push';
		default:
			return null;
	}
};
