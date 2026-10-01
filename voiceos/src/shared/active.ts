// Which sessions exist for voice. Active: Voice OS runs its Claude and voice drives it fully.
// Inactive: no process, nothing said, invisible to the kernel — browsable on the page, where it can
// be activated. The one reading of the set: nothing else reads state.active.
import { SETUP_REF } from './machine-ref.js';
import type { State } from './protocol.js';

// This Mac's setup session is always active: crew setup must answer from anywhere. A remote's setup
// session ("vm1:setup") is a session like any other.
export const isActive = (state: State, ref: string): boolean =>
	ref === SETUP_REF || state.active.includes(ref);

// The active sessions crew has, in the developer's order with this Mac's setup first.
export const listActiveRefs = (state: State): string[] => [
	...(state.sessions[SETUP_REF] ? [SETUP_REF] : []),
	...state.active.filter((ref) => ref !== SETUP_REF && state.sessions[ref]),
];

// The active sessions in the page's order (state.order): what the kernel's turn lists.
export const listActiveInOrder = (state: State): string[] =>
	state.order.filter((ref) => isActive(state, ref));

// Active refs whose session is not here (its machine out of reach, its worktree gone): the page shows
// them as their own tiles, and they start once they are back.
export const listActiveMissing = (state: State): string[] =>
	state.active.filter((ref) => !state.sessions[ref]);
