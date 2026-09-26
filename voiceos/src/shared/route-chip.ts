import type { PendingAsk, State } from './protocol.js';
import { readLabel } from '../state/helpers.js';
import { resolveTypedTarget } from '../router/refs.js';

export interface RouteChip {
	label: string;
	isAnswering: boolean;
	isForKernel: boolean;
}

export const findCurrentAsk = (state: State): PendingAsk | null => {
	// The viewed session's oldest ask, else the oldest anywhere: asks preempt the grid, like speech.
	const viewedRef = state.view.kind === 'session' ? state.view.ref : null;
	const viewedAsk = viewedRef ? state.asks.find((ask) => ask.ref === viewedRef) : undefined;

	return viewedAsk ?? state.asks[0] ?? null;
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
