import { describe, expect, it } from 'bun:test';
import { run, worktree } from '../../test/support/reduce.js';
import type { State } from '../shared/protocol.js';
import { PEER_RUNS_KEPT, settlePeerRun, startPeerRun } from './peer-runs.js';

const REF = 'checkout-api/main';

const withSession = (): State => run([{ type: 'worktrees', worktrees: [worktree(REF)] }]).state;

const start = (state: State, requestId: string): State =>
	startPeerRun(
		state,
		REF,
		{
			requestId,
			kind: 'ask',
			fromRef: 'store/main',
			fromLabel: 'store/main',
			text: 'q',
			status: 'asking',
		},
		1,
	);

describe('startPeerRun', () => {
	it(`more than ${PEER_RUNS_KEPT} → the oldest settled go; one still going is never dropped`, () => {
		const ids = Array.from({ length: PEER_RUNS_KEPT + 2 }, (_, n) => `q${n}`);
		const started = ids.reduce(start, withSession());
		// q0 still going; every other one settled.
		const settled = ids
			.slice(1)
			.reduce((state, id) => settlePeerRun(state, REF, id, { status: 'answered' }, 2), started);
		const next = start(settled, 'q-new');

		expect(next.sessions[REF]?.peerRuns.map((peerRun) => peerRun.requestId)).toEqual([
			'q0',
			...ids.slice(4),
			'q-new',
		]);
	});

	it('all still going → none dropped', () => {
		const ids = Array.from({ length: PEER_RUNS_KEPT + 2 }, (_, n) => `q${n}`);

		expect(ids.reduce(start, withSession()).sessions[REF]?.peerRuns).toHaveLength(
			PEER_RUNS_KEPT + 2,
		);
	});
});
