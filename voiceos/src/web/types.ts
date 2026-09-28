import type { Action, ListenMode } from '../shared/protocol.js';

export type Dispatch = (action: Action) => void;

export type MicStatus = 'idle' | 'live' | 'denied';

// The server switched how this tab listens: another tab took it, the stream failed, or the developer
// said so.
export interface ListenCommand {
	mode: ListenMode;
}
