import { resolveRef } from '../router/refs.js';
import type { State } from '../shared/protocol.js';
import { isActive, listActiveInOrder } from '../shared/active.js';
import { isSetupRef } from '../shared/machine-ref.js';

export interface ToolResult {
	ok: boolean;
	content: string;
	// What the voice log adds to the call's line: how it was carried out ("aside").
	note?: string;
	// The kernel answers now, with no more tools: nothing else may happen after this result.
	isFinal?: true;
	// The kernel has more to do (a silent call that found the rest of the words): it reads this result
	// before the turn ends.
	isOpen?: true;
	// The call that actually happened, when a tool carried out another's job (answer → send_to).
	recordAs?: { name: string; input: Record<string, unknown> };
	// What Voice OS says for it, whatever the model wrote: a fixed line the developer listens for.
	reply?: string;
}

export const succeed = (content: unknown): ToolResult => ({
	ok: true,
	content: typeof content === 'string' ? content : JSON.stringify(content),
});

export const fail = (content: string): ToolResult => ({ ok: false, content });

// inactive: the words name a session that is not active — the caller asks to activate it
// (tools/activate.ts refuseInactive), never acts on it.
export type RefCheck = { ok: true; ref: string } | { ok: false; error: string; inactive?: string };

const toInactive = (ref: string): RefCheck => ({
	ok: false,
	error: `${ref} is not active`,
	inactive: ref,
});

// Resolved against every session first; a name an active session also answers to goes to that one
// rather than to an inactive one here. A setup session is never reached: it lives in Set up.
export const checkRef = (state: State, value: unknown): RefCheck => {
	if (typeof value !== 'string' || !value) {
		return { ok: false, error: 'missing ref' };
	}

	if (state.sessions[value] && !isSetupRef(value)) {
		return isActive(state, value) ? { ok: true, ref: value } : toInactive(value);
	}

	const anyRef = resolveRef(state, value, state.order);

	if (anyRef && isActive(state, anyRef)) {
		return { ok: true, ref: anyRef };
	}

	const activeRef = resolveRef(state, value);

	if (activeRef) {
		return { ok: true, ref: activeRef };
	}

	if (anyRef) {
		return toInactive(anyRef);
	}

	const active = listActiveInOrder(state);

	return {
		ok: false,
		error: `no active session "${value}". ${active.length ? `Active sessions: ${active.join(', ')}.` : 'No sessions are active.'} Another worktree is reached with activate.`,
	};
};
