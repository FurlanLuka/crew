// Where the developer has been: "go back" walks it, skipping what is gone.
import {
	VIEW_HISTORY_KEPT,
	type State,
	type View,
	type ViewHistoryEntry,
} from '../shared/protocol.js';
import type { Effect } from './reducer.js';
import { sayAck, sayRef } from './helpers.js';

export const isSameView = (first: View, second: View): boolean =>
	JSON.stringify(first) === JSON.stringify(second);

// Sessions (and machines) that are gone leave the history.
export const pruneViewHistory = (
	entries: ViewHistoryEntry[],
	isKept: (ref: string) => boolean,
	isMachineKept: (machine: string) => boolean = () => true,
): ViewHistoryEntry[] =>
	entries.filter(({ view }) =>
		view.kind === 'session'
			? isKept(view.ref)
			: view.kind !== 'grid' || !view.machine || isMachineKept(view.machine),
	);

// The view being left goes on top; the same view twice in a row is one.
export const pushViewHistory = (state: State, next: View): ViewHistoryEntry[] => {
	if (isSameView(state.view, next)) {
		return state.viewHistory;
	}

	const left = state.view.kind === 'session' ? state.sessions[state.view.ref] : undefined;
	const entry: ViewHistoryEntry = {
		view: state.view,
		...(left && left.status !== 'stopped' ? { wasLive: true as const } : {}),
	};

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
			skipped: string[];
			rest: ViewHistoryEntry[];
	  }
	| { kind: 'empty'; skipped: string[] };

// A session that stopped or was removed is passed over and named, so the developer knows why.
export const decideGoBack = (state: State): GoBackDecision => {
	const skipped: string[] = [];

	for (const [index, entry] of state.viewHistory.entries()) {
		const { view } = entry;
		const session = view.kind === 'session' ? state.sessions[view.ref] : undefined;

		// Gone, or stopped since the developer left it; a session that was never running is still a
		// screen to go back to.
		if (view.kind === 'session' && (!session || (entry.wasLive && session.status === 'stopped'))) {
			skipped.push(view.ref);
			continue;
		}

		return {
			kind: 'back',
			view,
			skipped,
			rest: state.viewHistory.slice(index + 1),
		};
	}

	return { kind: 'empty', skipped };
};

export const describeGoBack = (state: State, decision: GoBackDecision): Effect => {
	const skipped = decision.skipped.map((ref) => `${sayRef(state, ref)} stopped.`).join(' ');
	const said =
		decision.kind === 'back'
			? `Back to ${sayView(state, decision.view)}.`
			: 'Nothing to go back to.';

	return sayAck(skipped ? `${skipped} ${said}` : said);
};

// A switch Voice OS made for the developer is said before anything else plays there.
export const describeSwitching = (state: State, view: View): Effect =>
	sayAck(`Switching to ${sayView(state, view)}.`);
