import type { Action } from '../shared/protocol.js';

export type Dispatch = (action: Action) => void;

export type MicStatus = 'idle' | 'live' | 'denied';

export interface ListenOff {
	reason: string;
}
