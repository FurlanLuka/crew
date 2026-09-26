import type { Action } from '../shared/protocol.js';

export type Dispatch = (action: Action) => void;

export type MicStatus = 'idle' | 'live' | 'denied';

// The server switched this tab's hands-free: another tab took it, the stream failed, or the developer said so.
export interface HandsFreeCommand {
	isOn: boolean;
}
