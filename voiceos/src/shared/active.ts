// Which sessions exist for voice. Active: Voice OS runs its Claude and voice drives it fully.
// Inactive: no process, nothing said, invisible to the kernel — browsable on the page, where it can
// be activated. The one reading of the set: nothing else reads state.active.
import { isChatRef, isSetupRef, readMachine } from './machine-ref.js';
import type { PendingAsk, State } from './protocol.js';

// A setup session (this Mac's "setup", a remote's "vm1:setup") is never active: it lives in Set up,
// where the developer types to it, and voice neither hears it nor talks to it.
export const isActive = (state: State, ref: string): boolean =>
	!isSetupRef(ref) && state.active.includes(ref);

// Whether Voice OS keeps a session's Claude running: an active one, or a machine's setup session,
// which runs for Set up's chat. Only the lifecycle sites (start, stop, resync, delivery) ask this;
// everything voice says or hears asks isActive.
export const canRun = (state: State, ref: string): boolean =>
	isSetupRef(ref) || isActive(state, ref);

// The active sessions crew has, in the developer's order.
export const listActiveRefs = (state: State): string[] =>
	state.active.filter((ref) => !isSetupRef(ref) && state.sessions[ref]);

// The worktrees voice can name or activate, in the page's order: every session but the setup
// sessions, on one machine (LOCAL_MACHINE for this Mac) or, with null, on every machine.
export const listVoiceRefsOn = (state: State, machine: string | null): string[] =>
	state.order.filter(
		(ref) => !isSetupRef(ref) && (machine === null || readMachine(ref) === machine),
	);

export interface MachineCounts {
	worktrees: number;
	active: number;
	plain: number;
}

// What a machine holds, as Home's cards and the New menu show it.
export const countMachineRefs = (state: State, machine: string): MachineCounts => {
	const refs = listVoiceRefsOn(state, machine);

	return {
		worktrees: refs.filter((ref) => !isChatRef(ref)).length,
		active: refs.filter((ref) => isActive(state, ref)).length,
		plain: refs.filter(isChatRef).length,
	};
};

// The active sessions in the page's order (state.order): what the kernel's turn lists.
export const listActiveInOrder = (state: State): string[] =>
	state.order.filter((ref) => isActive(state, ref));

// Active refs whose session is not here (its machine out of reach, its worktree gone): the page shows
// them as their own tiles, and they start once they are back.
export const listActiveMissing = (state: State): string[] =>
	state.active.filter((ref) => !isSetupRef(ref) && !state.sessions[ref]);

// The asks voice hears and answers: a setup session's are answered in Set up's chat, never spoken.
export const listHeardAsks = (state: State): PendingAsk[] =>
	state.asks.filter((ask) => !isSetupRef(ask.ref));
