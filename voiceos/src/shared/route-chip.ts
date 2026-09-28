import type { PendingAsk, State } from './protocol.js';
import { readLabel } from '../state/helpers.js';
import { resolveTypedTarget } from '../router/refs.js';

export interface RouteChip {
	label: string;
	isAnswering: boolean;
	isForKernel: boolean;
}

export const findCurrentAsk = (state: State): PendingAsk | null => {
	// On a session, only its own ask: another session's is announced and waits for the developer to
	// switch there. Mission Control is the overview, so the oldest anywhere preempts it, like speech.
	if (state.view.kind === 'session') {
		const viewedRef = state.view.ref;

		return state.asks.find((ask) => ask.ref === viewedRef) ?? null;
	}

	return state.asks[0] ?? null;
};

interface DescribeRouteChipParams {
	draft?: string;
}

export const describeRouteChip = (
	state: State,
	{ draft = '' }: DescribeRouteChipParams = {},
): RouteChip => {
	// Only what can be said before the kernel decides: it makes the routing decisions.
	const typedRef = draft.trim() ? resolveTypedTarget(state, draft) : null;

	if (typedRef) {
		return { label: `→ ${readLabel(state, typedRef)}`, isAnswering: false, isForKernel: false };
	}

	const ask = findCurrentAsk(state);

	if (ask) {
		return {
			label: `answering ${readLabel(state, ask.ref)}`,
			isAnswering: true,
			isForKernel: false,
		};
	}

	return { label: '→ Voice OS', isAnswering: false, isForKernel: true };
};
