import { resolveRef } from '../router/refs.js';
import type { State } from '../shared/protocol.js';

export interface ToolResult {
	ok: boolean;
	content: string;
	// What the voice log adds to the call's line: how it was carried out ("aside").
	note?: string;
	// The kernel answers now, with no more tools: nothing else may happen after this result.
	isFinal?: true;
	// The call that actually happened, when a tool carried out another's job (answer → send_to).
	recordAs?: { name: string; input: Record<string, unknown> };
}

export const succeed = (content: unknown): ToolResult => ({
	ok: true,
	content: typeof content === 'string' ? content : JSON.stringify(content),
});

export const fail = (content: string): ToolResult => ({ ok: false, content });

export type RefCheck = { ok: true; ref: string } | { ok: false; error: string };

export const checkRef = (state: State, value: unknown): RefCheck => {
	if (typeof value !== 'string' || !value) {
		return { ok: false, error: 'missing ref' };
	}

	if (state.sessions[value]) {
		return { ok: true, ref: value };
	}

	const resolvedRef = resolveRef(state, value);

	if (resolvedRef) {
		return { ok: true, ref: resolvedRef };
	}

	return { ok: false, error: `no session "${value}". Sessions: ${state.order.join(', ')}` };
};
