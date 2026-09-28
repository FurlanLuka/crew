import { describe, expect, it } from 'bun:test';
import type { Input, PendingAsk, State } from '../shared/protocol.js';
import { run, worktree } from '../../test/support/reduce.js';
import type { Snapshot } from './protocol.js';
import { planResync } from './resync.js';

const VM1 = { id: 'vm1', host: 'vm1', name: 'Build box' };
const REMOTE = 'vm1:store/main';

const mainWith = (inputs: Input[] = []): State =>
	run([
		{ type: 'machines', machines: [VM1] },
		{ type: 'worktrees', worktrees: [worktree(REMOTE)] },
		{ type: 'machine_resynced', id: 'vm1', inputs: [] },
		...inputs,
	]).state;

const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({
	worktrees: [worktree('store/main')],
	sessions: [],
	asks: [],
	asides: [],
	...patch,
});

const plan = (ask: PendingAsk): PendingAsk => ask;

describe('planResync', () => {
	it('a fresh main, the remote working → started and running, nothing told', () => {
		const { inputs, finished } = planResync(
			mainWith(),
			'vm1',
			snapshot({ sessions: [{ ref: 'store/main', status: 'running', lastTurn: null }] }),
		);

		expect(inputs).toEqual([
			{ type: 'session_started', ref: REMOTE },
			{ type: 'turn_started', ref: REMOTE },
		]);
		expect(finished).toEqual([]);
	});

	it('a fresh main, an old turn there → no news: not reported', () => {
		const { inputs } = planResync(
			mainWith(),
			'vm1',
			snapshot({
				sessions: [
					{
						ref: 'store/main',
						status: 'idle',
						lastTurn: { id: 't9', text: 'old', costUsd: 1, head: null },
					},
				],
			}),
		);

		expect(inputs).toEqual([{ type: 'session_started', ref: REMOTE }]);
	});

	it('the turn the main waited on ended out of reach → reported, with its commit', () => {
		const waiting = mainWith([
			{ type: 'session_started', ref: REMOTE },
			{ type: 'send', ref: REMOTE, text: 'refactor it' },
		]);
		const { inputs, finished } = planResync(
			waiting,
			'vm1',
			snapshot({
				sessions: [
					{
						ref: 'store/main',
						status: 'idle',
						lastTurn: { id: 't1', text: 'Done.', costUsd: 0.3, head: 'abc' },
					},
				],
			}),
		);

		expect(inputs).toEqual([
			{ type: 'turn_ended', ref: REMOTE, costUsd: 0.3, text: 'Done.', turnId: 't1', head: 'abc' },
		]);
		expect(finished).toEqual([REMOTE]);
	});

	it('a turn already reported → not again', () => {
		const known = mainWith([
			{ type: 'session_started', ref: REMOTE },
			{ type: 'turn_ended', ref: REMOTE, costUsd: 0, text: 'Done.', turnId: 't1' },
		]);
		const { inputs } = planResync(
			known,
			'vm1',
			snapshot({
				sessions: [
					{
						ref: 'store/main',
						status: 'idle',
						lastTurn: { id: 't1', text: 'Done.', costUsd: 0, head: null },
					},
				],
			}),
		);

		expect(inputs).toEqual([]);
	});

	it('still working there → a notice that the gap is not shown', () => {
		const working = mainWith([
			{ type: 'session_started', ref: REMOTE },
			{ type: 'send', ref: REMOTE, text: 'go' },
		]);
		const { inputs } = planResync(
			working,
			'vm1',
			snapshot({ sessions: [{ ref: 'store/main', status: 'running', lastTurn: null }] }),
		);

		expect(inputs).toEqual([expect.objectContaining({ type: 'session_notice', ref: REMOTE })]);
	});

	it('running here, gone there (its Voice OS restarted) → exited, words kept', () => {
		const working = mainWith([{ type: 'session_started', ref: REMOTE }]);
		const { inputs } = planResync(working, 'vm1', snapshot());

		expect(inputs).toEqual([expect.objectContaining({ type: 'worker_exited', ref: REMOTE })]);
		expect((inputs[0] as { error: string | null }).error).not.toBeNull();
	});

	it('asks → opened when only there, closed when only here', () => {
		const onlyHere = plan({
			id: 'vm1:ask-a',
			ref: REMOTE,
			at: 1,
			kind: 'plan',
			input: {},
			plan: 'x',
		});
		const withAsk = mainWith([
			{ type: 'session_started', ref: REMOTE },
			{ type: 'ask_opened', ask: onlyHere },
		]);
		const { inputs } = planResync(
			withAsk,
			'vm1',
			snapshot({
				sessions: [{ ref: 'store/main', status: 'running', lastTurn: null }],
				asks: [{ id: 'ask-b', ref: 'store/main', at: 2, kind: 'plan', input: {}, plan: 'y' }],
			}),
		);

		expect(inputs).toContainEqual({ type: 'ask_closed', askId: 'vm1:ask-a' });
		expect(inputs).toContainEqual({
			type: 'ask_opened',
			ask: { id: 'vm1:ask-b', ref: REMOTE, at: 2, kind: 'plan', input: {}, plan: 'y' },
		});
	});
});

describe('planResync keeps to its machine', () => {
	const REMOTE2 = 'vm2:store/main';
	const busy = (): State =>
		run([
			{ type: 'machines', machines: [VM1, { id: 'vm2', host: 'vm2', name: 'GPU box' }] },
			{
				type: 'worktrees',
				worktrees: [worktree('store/main'), worktree(REMOTE), worktree(REMOTE2)],
			},
			{ type: 'machine_resynced', id: 'vm1', inputs: [] },
			{ type: 'machine_resynced', id: 'vm2', inputs: [] },
			{ type: 'start_session', ref: 'store/main' },
			{ type: 'session_started', ref: 'store/main' },
			{ type: 'session_started', ref: REMOTE2 },
			{
				type: 'ask_opened',
				ask: { id: 'ask-local', ref: 'store/main', at: 1, kind: 'plan', input: {}, plan: 'p' },
			},
			{
				type: 'ask_opened',
				ask: { id: 'vm2:ask-x', ref: REMOTE2, at: 1, kind: 'plan', input: {}, plan: 'q' },
			},
		]).state;

	it("this Mac's and another machine's sessions and asks → untouched by vm1's snapshot", () => {
		const { inputs } = planResync(busy(), 'vm1', snapshot());

		expect(inputs).toEqual([]);
	});

	it("Voice OS's own held ask on a remote session → kept: it lives on the main", () => {
		const held = run(
			[
				{ type: 'session_started', ref: REMOTE },
				{
					type: 'ask_opened',
					ask: {
						id: 'held-1',
						ref: REMOTE,
						at: 1,
						kind: 'command',
						command: 'clear',
						text: '/clear',
					},
				},
			],
			{ start: mainWith() },
		).state;
		const { inputs } = planResync(
			held,
			'vm1',
			snapshot({ sessions: [{ ref: 'store/main', status: 'idle', lastTurn: null }] }),
		);

		expect(inputs.some((input) => input.type === 'ask_closed')).toBe(false);
	});

	it('an aside asked before the drop and gone there → failed, so it stops showing "asking"', () => {
		const asking = mainWith([{ type: 'session_started', ref: REMOTE }]);
		const withAside: State = {
			...asking,
			sessions: {
				...asking.sessions,
				[REMOTE]: {
					...asking.sessions[REMOTE]!,
					stream: [
						{
							id: 'aside-1',
							at: 5,
							kind: 'aside',
							question: 'why?',
							answer: null,
							status: 'asking',
						},
					],
				},
			},
		};
		const { inputs } = planResync(
			withAside,
			'vm1',
			snapshot({ sessions: [{ ref: 'store/main', status: 'idle', lastTurn: null }] }),
		);

		expect(inputs).toEqual([
			{
				type: 'aside_settled',
				ref: REMOTE,
				itemId: 'aside-1',
				question: 'why?',
				status: 'failed',
				answer: null,
			},
		]);
	});

	it('a session still starting there → left to its own start report', () => {
		const { inputs } = planResync(
			mainWith(),
			'vm1',
			snapshot({ sessions: [{ ref: 'store/main', status: 'starting', lastTurn: null }] }),
		);

		expect(inputs).toEqual([]);
	});

	it('idle there, the main thought it worked, no newer turn → an empty end, nothing to report', () => {
		const working = mainWith([
			{ type: 'session_started', ref: REMOTE },
			{ type: 'send', ref: REMOTE, text: 'go' },
		]);
		const { inputs, finished } = planResync(
			working,
			'vm1',
			snapshot({ sessions: [{ ref: 'store/main', status: 'idle', lastTurn: null }] }),
		);

		expect(inputs).toEqual([{ type: 'turn_ended', ref: REMOTE, costUsd: 0, text: '' }]);
		expect(finished).toEqual([]);
	});
});
