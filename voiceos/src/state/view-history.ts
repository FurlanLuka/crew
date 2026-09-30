// Where the developer has been: "go back" walks it, skipping what is gone, and brings back the
// conversation they had there while it is still live.
import {
	VIEW_HISTORY_KEPT,
	type Exchange,
	type State,
	type View,
	type ViewHistoryEntry,
} from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { isExchangeLive, pruneExchange } from './exchange.js';
import type { Effect } from './reducer.js';
import { sayRef } from './helpers.js';

const log = createLogger('view-history');

export const isSameView = (first: View, second: View): boolean =>
	JSON.stringify(first) === JSON.stringify(second);

// Sessions (and machines) that are gone leave the history, and take their conversations with them.
export const pruneViewHistory = (
	entries: ViewHistoryEntry[],
	isKept: (ref: string) => boolean,
	isMachineKept: (machine: string) => boolean = () => true,
): ViewHistoryEntry[] =>
	entries
		.filter(({ view }) =>
			view.kind === 'session'
				? isKept(view.ref)
				: view.kind !== 'grid' || !view.machine || isMachineKept(view.machine),
		)
		.map((entry) => ({ ...entry, exchange: pruneExchange(entry.exchange, isKept) }));

// The view being left, with its conversation, goes on top; the same view twice in a row is one.
export const pushViewHistory = (state: State, next: View): ViewHistoryEntry[] => {
	if (isSameView(state.view, next)) {
		return state.viewHistory;
	}

	const entry: ViewHistoryEntry = { view: state.view, exchange: state.exchange };

	return [entry, ...state.viewHistory.filter((kept) => !isSameView(kept.view, state.view))].slice(
		0,
		VIEW_HISTORY_KEPT,
	);
};

const sayView = (state: State, view: View): string => {
	switch (view.kind) {
		case 'session':
			return sayRef(state, view.ref);
		case 'pinned':
			return 'Pinned';
		case 'machines':
			return 'your machines';
		case 'grid':
			return 'Mission Control';
	}
};

export type GoBackDecision =
	| {
			kind: 'back';
			view: View;
			exchange: Exchange | null;
			skipped: string[];
			rest: ViewHistoryEntry[];
	  }
	| { kind: 'empty'; skipped: string[] };

interface DecideGoBackParams {
	state: State;
	now: number;
}

// A session that stopped or was removed is passed over and named, so the developer knows why.
export const decideGoBack = ({ state, now }: DecideGoBackParams): GoBackDecision => {
	const skipped: string[] = [];

	for (const [index, entry] of state.viewHistory.entries()) {
		const { view } = entry;
		const session = view.kind === 'session' ? state.sessions[view.ref] : undefined;
		const isGone = view.kind === 'session' && (!session || session.status === 'stopped');

		if (isGone && view.kind === 'session') {
			skipped.push(view.ref);
			continue;
		}

		return {
			kind: 'back',
			view,
			exchange: isExchangeLive(entry.exchange, now) ? entry.exchange : null,
			skipped,
			rest: state.viewHistory.slice(index + 1),
		};
	}

	return { kind: 'empty', skipped };
};

const say = (text: string): Effect => ({
	type: 'speak',
	text,
	source: 'kernel',
	isReply: true,
	isAck: true,
	priority: 'high',
});

export const describeGoBack = (state: State, decision: GoBackDecision): Effect => {
	const skipped = decision.skipped.map((ref) => `${sayRef(state, ref)} stopped.`).join(' ');
	const said =
		decision.kind === 'back'
			? `Back to ${sayView(state, decision.view)}.`
			: 'Nothing to go back to.';

	log.info('go back', {
		to: decision.kind === 'back' ? decision.view.kind : null,
		skipped: decision.skipped.length,
	});

	return say(skipped ? `${skipped} ${said}` : said);
};

// A switch Voice OS made for the developer is said before anything else plays there.
export const describeSwitching = (state: State, view: View): Effect =>
	say(`Switching to ${sayView(state, view)}.`);
