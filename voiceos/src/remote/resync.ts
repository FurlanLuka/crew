// A machine came back (or the main restarted): its snapshot, turned into the inputs that bring the
// main's picture of that machine in line. No event from the gap is replayed; the recap tells it.

import { joinRef, machineOf } from '../shared/machine-ref.js';
import { isSdkAsk, type Observation, type State } from '../shared/protocol.js';
import type { Snapshot } from './protocol.js';

export interface ResyncPlan {
	inputs: Observation[];
	// Sessions whose turn ended while out of reach, for the recap.
	finished: string[];
}

const GAP_NOTICE = 'Reconnected. What it did while out of reach is not shown here.';
const LOST_NOTICE = 'It stopped while its machine was out of reach.';

const isWorking = (status: string | undefined): boolean =>
	status === 'running' || status === 'blocked';

export const planResync = (state: State, machine: string, snapshot: Snapshot): ResyncPlan => {
	const inputs: Observation[] = [];
	const finished: string[] = [];
	const seen = new Set<string>();

	for (const remote of snapshot.sessions) {
		const ref = joinRef(machine, remote.ref);
		const session = state.sessions[ref];

		seen.add(ref);

		if (!session || remote.status === 'starting') {
			continue;
		}

		const wasWorking = isWorking(session.status);

		if (session.status === 'stopped' || session.status === 'starting') {
			inputs.push({ type: 'session_started', ref });
		}

		// Listed once at its start, which a main that restarted since never heard.
		if (remote.commands) {
			inputs.push({ type: 'commands_listed', ref, commands: remote.commands });
		}

		// The meter's last reading: a main that restarted has none until the next turn.
		if (remote.context) {
			inputs.push({ type: 'context_usage', ref, ...remote.context });
		}

		if (remote.status === 'running') {
			if (!wasWorking) {
				inputs.push({ type: 'turn_started', ref });
			}

			if (wasWorking) {
				inputs.push({ type: 'session_notice', ref, text: GAP_NOTICE });
			}

			continue;
		}

		const { lastTurn } = remote;

		// A turn the main never saw end: one it was waiting on, or one after a turn it knows. A main
		// that just started knows none, and old turns are no news to it.
		const isNews =
			lastTurn !== null &&
			lastTurn.id !== session.lastTurnId &&
			(wasWorking || session.lastTurnId !== null);

		if (lastTurn && isNews) {
			inputs.push({
				type: 'turn_ended',
				ref,
				costUsd: lastTurn.costUsd,
				text: lastTurn.text,
				turnId: lastTurn.id,
				head: lastTurn.head,
			});
			finished.push(ref);
		} else if (wasWorking) {
			// Idle there with no newer turn: the turn the main thought ran is over, with nothing to tell.
			inputs.push({ type: 'turn_ended', ref, costUsd: 0, text: '' });
		}
	}

	// Running here, gone there: that machine's Voice OS restarted and its session with it.
	for (const ref of state.order) {
		const session = state.sessions[ref];

		if (machineOf(ref) === machine && !seen.has(ref) && session && session.status !== 'stopped') {
			inputs.push({ type: 'worker_exited', ref, error: LOST_NOTICE });
		}
	}

	const remoteAsks = snapshot.asks.map((ask) => ({
		...ask,
		id: joinRef(machine, ask.id),
		ref: joinRef(machine, ask.ref),
	}));
	const remoteAskIds = new Set(remoteAsks.map((ask) => ask.id));
	const knownAskIds = new Set(state.asks.map((ask) => ask.id));

	for (const ask of state.asks) {
		// Voice OS's own held asks live here, not there.
		if (machineOf(ask.ref) === machine && isSdkAsk(ask) && !remoteAskIds.has(ask.id)) {
			inputs.push({ type: 'ask_closed', askId: ask.id });
		}
	}

	for (const ask of remoteAsks) {
		if (!knownAskIds.has(ask.id)) {
			inputs.push({ type: 'ask_opened', ask });
		}
	}

	const asking = new Set(
		snapshot.asides.map((aside) => `${joinRef(machine, aside.ref)} ${aside.itemId}`),
	);

	for (const ref of state.order) {
		if (machineOf(ref) !== machine) {
			continue;
		}

		for (const item of state.sessions[ref]?.stream ?? []) {
			if (item.kind === 'aside' && item.status === 'asking' && !asking.has(`${ref} ${item.id}`)) {
				inputs.push({
					type: 'aside_settled',
					ref,
					itemId: item.id,
					question: item.question,
					status: 'failed',
					answer: null,
				});
			}
		}
	}

	return { inputs, finished };
};
