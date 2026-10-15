// Another session's ask or secret request, as the asked session keeps it: a side-panel row whose
// copy's steps fill in live. Its conversation never sees it.
import type { Input, PeerRun, Session, State, Stamped } from '../shared/protocol.js';
import { SUBAGENT_ITEMS_KEPT, clipItem } from './subagents.js';

export const PEER_RUNS_KEPT = 10;

type NewRun = Pick<PeerRun, 'requestId' | 'kind' | 'fromRef' | 'fromLabel' | 'text' | 'status'>;

export type RunPatch = Partial<Pick<PeerRun, 'status' | 'answer' | 'settledAt' | 'step'>>;

const updateRuns = (state: State, ref: string, change: (runs: PeerRun[]) => PeerRun[]): State => {
	const session = state.sessions[ref];

	return session
		? {
				...state,
				sessions: { ...state.sessions, [ref]: { ...session, peerRuns: change(session.peerRuns) } },
			}
		: state;
};

// Newest kept; one still going is never the one dropped.
const keepRecent = (runs: PeerRun[]): PeerRun[] => {
	const kept = [...runs];

	while (kept.length > PEER_RUNS_KEPT) {
		const oldestSettled = kept.findIndex((run) => run.settledAt !== null);

		if (oldestSettled === -1) {
			break;
		}

		kept.splice(oldestSettled, 1);
	}

	return kept;
};

export const startPeerRun = (state: State, ref: string, run: NewRun, at: number): State =>
	updateRuns(state, ref, (runs) =>
		keepRecent([
			...runs,
			{ ...run, startedAt: at, settledAt: null, step: null, items: [], answer: null },
		]),
	);

export const patchPeerRun = (
	state: State,
	ref: string,
	requestId: string,
	patch: RunPatch,
): State =>
	updateRuns(state, ref, (runs) =>
		runs.map((run) => (run.requestId === requestId ? { ...run, ...patch } : run)),
	);

// It ended, one way or another: the row stops showing a step and starts to age.
export const settlePeerRun = (
	state: State,
	ref: string,
	requestId: string,
	patch: Pick<PeerRun, 'status'> & Partial<Pick<PeerRun, 'answer'>>,
	at: number,
): State => patchPeerRun(state, ref, requestId, { ...patch, step: null, settledAt: at });

export const findPeerRun = (session: Session | undefined, requestId: string): PeerRun | undefined =>
	session?.peerRuns.find((run) => run.requestId === requestId);

type ForkItem = Extract<Input, { type: 'session_fork_item' }>;

// One step of the copy. A step for a run already settled (it timed out, or the main restarted) or
// unknown changes nothing.
export const reduceForkItem = (state: State, input: ForkItem, stamped: Stamped): State => {
	const run = findPeerRun(state.sessions[input.ref], input.id);

	if (!run || run.settledAt !== null) {
		return state;
	}

	return patchPeerRunItems(state, input, stamped);
};

const patchPeerRunItems = (state: State, input: ForkItem, stamped: Stamped): State =>
	updateRuns(state, input.ref, (runs) =>
		runs.map((run) =>
			run.requestId === input.id
				? {
						...run,
						items: [...run.items, clipItem(input.item, stamped.id, stamped.at)].slice(
							-SUBAGENT_ITEMS_KEPT,
						),
						step: input.item.kind === 'tool' ? input.item.summary : run.step,
					}
				: run,
		),
	);

// A run whose request is gone from the main's books (its ask went with a removed machine): it ends
// here, wherever it is, so no row waits forever.
export const settleRunsOf = (
	state: State,
	requestId: string,
	patch: Pick<PeerRun, 'status'> & Partial<Pick<PeerRun, 'answer'>>,
	at: number,
): State =>
	Object.entries(state.sessions).reduce(
		(current, [ref, session]) =>
			session.peerRuns.some((run) => run.requestId === requestId && run.settledAt === null)
				? settlePeerRun(current, ref, requestId, patch, at)
				: current,
		state,
	);
