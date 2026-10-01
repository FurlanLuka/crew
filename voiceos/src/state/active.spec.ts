import { describe, expect, it } from 'bun:test';
import type { Input, Observation, State } from '../shared/protocol.js';
import { parentView } from '../shared/machines.js';
import type { Effect } from './reducer.js';
import { createFixtureState } from '../../test/support/state.js';
import { run, worktree } from '../../test/support/reduce.js';
import { stopWorker } from './active.js';

const VM1 = { id: 'vm1', host: 'dev@vm1.example.com', name: 'Build box' };
const REMOTE = 'vm1:store/main';
const REMOTE_OTHER = 'vm1:store/wrk1';
const LOCAL = 'store/main';
const OTHER = 'store/wrk1';

const remoteWorktree = (ref: string) => ({ ...worktree(ref), label: ref.slice('vm1:'.length) });

// A main that knows vm1, not yet connected, with two sessions there and two here; none active.
const known = (extra: Input[] = []): State =>
	run([
		{ type: 'machines', machines: [VM1] },
		{
			type: 'worktrees',
			worktrees: [
				worktree(LOCAL),
				worktree(OTHER),
				remoteWorktree(REMOTE),
				remoteWorktree(REMOTE_OTHER),
			],
		},
		...extra,
	]).state;

// The same, vm1 connected with nothing running there.
const connected = (extra: Input[] = []): State =>
	known([{ type: 'machine_resynced', id: 'vm1', inputs: [] }, ...extra]);

const said = (effects: Effect[]): string[] =>
	effects.flatMap((effect) => (effect.type === 'speak' ? [effect.text] : []));

const starts = (effects: Effect[]): string[] =>
	effects.flatMap((effect) => (effect.type === 'worker_start' ? [effect.ref] : []));

const stops = (effects: Effect[]): string[] =>
	effects.flatMap((effect) => (effect.type === 'worker_stop' ? [effect.ref] : []));

describe('activate', () => {
	it('from the page → added and started, nothing said', () => {
		const { state, effects } = run([{ type: 'activate', ref: OTHER }], { start: connected() });

		expect(state.active).toEqual([OTHER]);
		expect(state.sessions[OTHER]?.status).toBe('starting');
		expect(effects).toEqual([{ type: 'worker_start', ref: OTHER }]);
	});

	it('by voice → started, "Activated X. Switch there?" and the switch offer open', () => {
		const { state, effects } = run([{ type: 'activate', ref: OTHER, announce: true }], {
			start: connected(),
			at: 50,
		});

		expect(starts(effects)).toEqual([OTHER]);
		expect(said(effects)).toEqual(['Activated store, work 1. Switch there?']);
		expect(effects).toContainEqual(expect.objectContaining({ isAsking: true, ref: OTHER }));
		expect(state.switchOffer).toEqual({ ref: OTHER, at: 50 });
	});

	it('by voice, already on screen → started, nothing said, opened from Active now', () => {
		const { state, effects } = run(
			[
				{ type: 'switch_view', view: { kind: 'session', ref: OTHER } },
				{ type: 'activate', ref: OTHER, announce: true },
			],
			{ start: connected() },
		);

		expect(effects).toEqual([{ type: 'worker_start', ref: OTHER }]);
		expect(state.switchOffer).toBeNull();
		expect(state.view).toEqual({ kind: 'session', ref: OTHER, from: 'active' });
		expect(parentView(state)).toEqual({ kind: 'active' });
	});

	it('by voice, its machine out of reach → added, not started, and said when it starts', () => {
		const { state, effects } = run(
			[
				{ type: 'machine_status', id: 'vm1', status: 'unreachable', detail: 'timeout' },
				{ type: 'activate', ref: REMOTE, announce: true },
			],
			{ start: connected() },
		);

		expect(state.active).toEqual([REMOTE]);
		expect(state.sessions[REMOTE]?.status).toBe('stopped');
		expect(starts(effects)).toEqual([]);
		expect(said(effects)).toEqual([
			"Build box is out of reach; store, main on Build box starts when it's back.",
		]);
		expect(state.switchOffer).toBeNull();
	});

	it('from the page, its machine out of reach → added, nothing said, nothing sent', () => {
		const { state, effects } = run(
			[
				{ type: 'machine_status', id: 'vm1', status: 'unreachable', detail: 'timeout' },
				{ type: 'activate', ref: REMOTE },
			],
			{ start: connected() },
		);

		expect(state.active).toEqual([REMOTE]);
		expect(effects).toEqual([]);
	});

	it('twice → in the set once, started once', () => {
		const { state, effects } = run(
			[
				{ type: 'activate', ref: OTHER },
				{ type: 'activate', ref: OTHER },
			],
			{ start: connected() },
		);

		expect(state.active).toEqual([OTHER]);
		expect(effects).toEqual([]);
	});

	it('a ref crew does not have, or of a machine the state does not know → nothing', () => {
		const start = connected();

		for (const ref of ['store/wrk9', 'gpu:store/main']) {
			const { state, effects } = run([{ type: 'activate', ref }], { start });

			expect(state.active).toEqual([]);
			expect(effects).toEqual([]);
		}
	});

	it("this Mac's setup → started if it is stopped, never put in the set", () => {
		const start = run(
			[{ type: 'worktrees', worktrees: [{ ...worktree('setup'), isPinned: true }] }],
			{ start: connected() },
		).state;
		const stopped = run([{ type: 'worker_exited', ref: 'setup', error: null }], { start }).state;
		const { state, effects } = run([{ type: 'activate', ref: 'setup' }], { start: stopped });

		expect(state.active).toEqual([]);
		expect(effects).toEqual([{ type: 'worker_start', ref: 'setup' }]);
	});
});

describe('deactivate', () => {
	const activeIdle = (extra: Input[] = []): State =>
		connected([
			{ type: 'activate', ref: OTHER },
			{ type: 'activate', ref: LOCAL },
			{ type: 'session_started', ref: OTHER },
			...extra,
		]);

	it('→ removed from the set, the rest keep their order; stopped, its speech dropped', () => {
		const { state, effects } = run([{ type: 'deactivate', ref: OTHER }], {
			start: activeIdle(),
		});

		expect(state.active).toEqual([LOCAL]);
		expect(state.sessions[OTHER]?.status).toBe('stopped');
		expect(effects).toEqual([
			{ type: 'drop_speech', ref: OTHER, before: Number.MAX_SAFE_INTEGER },
			{ type: 'worker_stop', ref: OTHER },
		]);
	});

	it('its worktree gone → still removed from the set', () => {
		const { state } = run(
			[
				{ type: 'worktrees', worktrees: [worktree(LOCAL)] },
				{ type: 'deactivate', ref: OTHER },
			],
			{ start: activeIdle() },
		);

		expect(state.active).toEqual([LOCAL]);
	});

	it('its machine out of reach → still removed from the set', () => {
		const { state } = run(
			[
				{ type: 'activate', ref: REMOTE },
				{ type: 'machine_status', id: 'vm1', status: 'unreachable', detail: 'timeout' },
				{ type: 'deactivate', ref: REMOTE },
			],
			{ start: activeIdle() },
		);

		expect(state.active).toEqual([OTHER, LOCAL]);
	});

	it('the session on screen → it stays on screen, no longer from Active: Esc goes to its machine', () => {
		const { state } = run(
			[
				{ type: 'switch_view', view: { kind: 'session', ref: OTHER } },
				{ type: 'deactivate', ref: OTHER },
			],
			{ start: activeIdle() },
		);

		expect(state.view).toEqual({ kind: 'session', ref: OTHER });
		expect(state.focus).toBe(OTHER);
		expect(parentView(state)).toEqual({ kind: 'grid', machine: 'local' });
	});

	it("an inactive session, or this Mac's setup → nothing", () => {
		const start = run(
			[{ type: 'worktrees', worktrees: [worktree(LOCAL), worktree(OTHER), worktree('setup')] }],
			{ start: activeIdle() },
		).state;

		for (const ref of [REMOTE, 'setup']) {
			const { state, effects } = run([{ type: 'deactivate', ref }], { start });

			expect(state.active).toEqual(start.active);
			expect(effects).toEqual([]);
		}
	});

	it('a late event from it → no update waits for the meanwhile line', () => {
		const { state } = run(
			[
				{ type: 'deactivate', ref: OTHER },
				{ type: 'meanwhile_added', ref: OTHER, kind: 'done', about: 'tests pass' },
			],
			{ start: activeIdle() },
		);

		expect(state.meanwhile).toEqual([]);
	});
});

describe('stopWorker', () => {
	const NOW = 1_000_000;
	const WORKING = 'store-front/wrk1';
	const SCREEN = 'store-front/main';

	// Everything Voice OS can hold for one session, with the developer on another one.
	const holding = (): State => {
		const state = createFixtureState(
			{
				view: SCREEN,
				ask: 'permission',
				askOn: WORKING,
				denied: WORKING,
				offer: { ref: WORKING, secondsAgo: 2 },
				update: { ref: WORKING, text: 'Tests pass.' },
				switchOffer: { ref: WORKING, secondsAgo: 1 },
				meanwhile: [
					{ ref: WORKING, kind: 'done', about: 'tests pass' },
					{ ref: 'checkout-api/main', kind: 'done', about: 'retries' },
				],
				work: [{ ref: WORKING, request: 'Run the tests.', minutesAgo: 2, queued: ['then lint'] }],
			},
			NOW,
		);

		return {
			...state,
			focus: WORKING,
			lastSpokenSend: { ref: WORKING, id: 'queued-0', text: 'then lint', at: NOW - 5000 },
			targetAsk: { ref: WORKING, screen: SCREEN, text: 'review it', at: NOW - 1000 },
		};
	};

	it('→ everything held for it let go; the others keep theirs', () => {
		const { state } = stopWorker(holding(), WORKING);
		const session = state.sessions[WORKING];

		expect(session).toMatchObject({
			status: 'stopped',
			queue: [],
			heldLine: null,
			needsUser: null,
			currentSendId: null,
		});
		expect(state.asks).toEqual([]);
		expect(state.denials).toEqual([]);
		expect(state.devOffer).toBeNull();
		expect(state.switchOffer).toBeNull();
		expect(state.targetAsk).toBeNull();
		expect(state.lastSpokenSend).toBeNull();
		expect(state.focus).toBeNull();
		expect(state.meanwhile.map((item) => item.ref)).toEqual(['checkout-api/main']);
	});

	it('→ its asks denied, its speech dropped, its worker stopped', () => {
		const { effects } = stopWorker(holding(), WORKING);

		expect(effects).toEqual([
			{
				type: 'resolve_ask',
				ref: WORKING,
				askId: 'ask-1',
				result: { behavior: 'deny', message: 'The session was stopped.' },
			},
			{ type: 'drop_speech', ref: WORKING, before: Number.MAX_SAFE_INTEGER },
			{ type: 'worker_stop', ref: WORKING },
		]);
	});

	it('the session on screen → it keeps the focus', () => {
		const onScreen: State = { ...holding(), view: { kind: 'session', ref: WORKING } };

		expect(stopWorker(onScreen, WORKING).state.focus).toBe(WORKING);
	});

	it('a target ask made on its screen → gone too', () => {
		const asked: State = {
			...holding(),
			targetAsk: { ref: SCREEN, screen: WORKING, text: 'review it', at: NOW - 1000 },
		};

		expect(stopWorker(asked, WORKING).state.targetAsk).toBeNull();
	});

	it('already stopped → no worker_stop; a ref crew does not have → nothing', () => {
		const stopped = createFixtureState({ stopped: [WORKING] }, NOW);

		expect(stopWorker(stopped, WORKING).effects).toEqual([
			{ type: 'drop_speech', ref: WORKING, before: Number.MAX_SAFE_INTEGER },
		]);
		expect(stopWorker(stopped, 'gone/main')).toEqual({ state: stopped, effects: [] });
	});
});

describe('active_loaded', () => {
	it('the saved set + one activated before it loaded → saved first, the early one after, no repeats', () => {
		const state = connected([
			{ type: 'activate', ref: OTHER },
			{ type: 'active_loaded', refs: [REMOTE, LOCAL, OTHER] },
		]);

		expect(state.active).toEqual([REMOTE, LOCAL, OTHER]);
	});

	it('a machine the state does not know → dropped; a gone local session → kept; setup → dropped', () => {
		const state = connected([
			{ type: 'active_loaded', refs: ['gpu:store/main', REMOTE, 'store/wrk9', 'setup'] },
		]);

		expect(state.active).toEqual([REMOTE, 'store/wrk9']);
	});

	it("this Mac's active sessions that are stopped → started once; a remote's wait for its link", () => {
		const { effects } = run(
			[
				{ type: 'activate', ref: OTHER },
				{ type: 'active_loaded', refs: [REMOTE, LOCAL, OTHER] },
			],
			{ start: known() },
		);

		// OTHER started when it was activated: the load does not start it again.
		expect(starts(effects)).toEqual([LOCAL]);
	});

	it('an inactive session → not started', () => {
		const { state } = run([{ type: 'active_loaded', refs: [LOCAL] }], { start: known() });

		expect(state.sessions[OTHER]?.status).toBe('stopped');
	});
});

describe('a worktree that appears', () => {
	it('active, and crew had not listed it yet → started when it appears, once', () => {
		const loaded = run(
			[
				{ type: 'worktrees', worktrees: [worktree(LOCAL)] },
				{ type: 'active_loaded', refs: [OTHER] },
			],
			{},
		);
		const appeared = run([{ type: 'worktrees', worktrees: [worktree(LOCAL), worktree(OTHER)] }], {
			start: loaded.state,
		});
		const again = run([{ type: 'worktrees', worktrees: [worktree(LOCAL), worktree(OTHER)] }], {
			start: appeared.state,
		});

		expect(starts(loaded.effects)).toEqual([]);
		expect(starts(appeared.effects)).toEqual([OTHER]);
		expect(starts(again.effects)).toEqual([]);
	});

	it('not active → not started', () => {
		const { effects } = run([{ type: 'worktrees', worktrees: [worktree(LOCAL)] }]);

		expect(effects).toEqual([]);
	});
});

describe('a switch to an active session', () => {
	const active = (extra: Input[] = []): State =>
		connected([{ type: 'activate', ref: REMOTE }, { type: 'activate', ref: LOCAL }, ...extra]);

	it('from Active, a machine grid, Mission Control or another session → opened from Active', () => {
		const starts: Input[] = [
			{ type: 'switch_view', view: { kind: 'active' } },
			{ type: 'switch_view', view: { kind: 'grid', machine: 'vm1' } },
			{ type: 'switch_view', view: { kind: 'machines' } },
			{ type: 'switch_view', view: { kind: 'session', ref: OTHER } },
		];

		for (const start of starts) {
			const state = active([
				start,
				{ type: 'switch_view', view: { kind: 'session', ref: REMOTE } },
			]);

			expect(state.view).toEqual({ kind: 'session', ref: REMOTE, from: 'active' });
		}
	});

	it('to a session not active, even asked from Active → its machine', () => {
		const state = active([
			{ type: 'switch_view', view: { kind: 'session', ref: REMOTE } },
			{ type: 'switch_view', view: { kind: 'session', ref: OTHER, from: 'active' } },
		]);

		expect(state.view).toEqual({ kind: 'session', ref: OTHER });
		expect(parentView(state)).toEqual({ kind: 'grid', machine: 'local' });
	});

	it('switch to Active → nothing said', () => {
		const { effects } = run([{ type: 'switch_view', view: { kind: 'active' } }], {
			start: active(),
		});

		expect(effects).toEqual([]);
	});
});

describe('an active session that goes away', () => {
	it('its worktree removed while open from Active → back to Active, still active', () => {
		const state = connected([
			{ type: 'activate', ref: OTHER },
			{ type: 'switch_view', view: { kind: 'session', ref: OTHER } },
			// A running session stays until its worker exits.
			{ type: 'worker_exited', ref: OTHER, error: null },
			{ type: 'worktrees', worktrees: [worktree(LOCAL)] },
		]);

		expect(state.view).toEqual({ kind: 'active' });
		expect(state.active).toEqual([OTHER]);
	});

	it('remove_machine → its sessions leave the set, this Mac keeps its own; open from Active → Active', () => {
		const state = connected([
			{ type: 'activate', ref: REMOTE },
			{ type: 'activate', ref: LOCAL },
			{ type: 'switch_view', view: { kind: 'session', ref: REMOTE } },
			{ type: 'remove_machine', id: 'vm1' },
		]);

		expect(state.active).toEqual([LOCAL]);
		expect(state.view).toEqual({ kind: 'active' });
	});

	it('its machine gone from machines.json → its sessions leave the set', () => {
		const state = connected([
			{ type: 'activate', ref: REMOTE },
			{ type: 'activate', ref: LOCAL },
			{ type: 'machines', machines: [] },
		]);

		expect(state.active).toEqual([LOCAL]);
	});
});

describe("a machine's sessions matched up when its link connects", () => {
	const resynced = (start: State, running: string[]) =>
		run(
			[
				{
					type: 'machine_resynced',
					id: 'vm1',
					inputs: running.map((ref): Observation => ({ type: 'session_started', ref })),
				},
			],
			{ start },
		);

	it('active and stopped → started', () => {
		const { effects } = resynced(known([{ type: 'activate', ref: REMOTE }]), []);

		expect(starts(effects)).toEqual([REMOTE]);
		expect(said(effects)).toEqual([]);
	});

	it('active and running there → left running, nothing said', () => {
		const { state, effects } = resynced(known([{ type: 'activate', ref: REMOTE }]), [REMOTE]);

		expect(state.sessions[REMOTE]?.status).toBe('idle');
		expect(effects).toEqual([]);
	});

	it('inactive and stopped → nothing', () => {
		expect(resynced(known(), []).effects).toEqual([]);
	});

	it('inactive and running there → stopped, and said: "Stopped one session on X that isn\'t active."', () => {
		const { state, effects } = resynced(known(), [REMOTE]);

		expect(stops(effects)).toEqual([REMOTE]);
		expect(state.sessions[REMOTE]?.status).toBe('stopped');
		expect(said(effects)).toEqual(["Stopped one session on Build box that isn't active."]);
	});

	it('first start after the update: the pins are the set → the others running there stopped, counted', () => {
		const loaded = known([{ type: 'active_loaded', refs: [LOCAL] }]);
		const { effects } = resynced(loaded, [REMOTE, REMOTE_OTHER]);

		expect(stops(effects)).toEqual([REMOTE, REMOTE_OTHER]);
		expect(said(effects)).toEqual(["Stopped 2 sessions on Build box that aren't active."]);
	});

	it('out of reach → nothing matched until it is back', () => {
		const { effects } = run(
			[
				{ type: 'machine_status', id: 'vm1', status: 'unreachable', detail: 'timeout' },
				{ type: 'activate', ref: REMOTE },
			],
			{ start: connected() },
		);

		expect(starts(effects)).toEqual([]);
	});

	it('a deactivate made while it was out of reach → reaches it on reconnect', () => {
		const offline = connected([
			{ type: 'activate', ref: REMOTE },
			{ type: 'session_started', ref: REMOTE },
			{ type: 'machine_status', id: 'vm1', status: 'unreachable', detail: 'timeout' },
			{ type: 'deactivate', ref: REMOTE },
		]);
		// The snapshot says it still runs there: the stop never got through.
		const { state, effects } = resynced(offline, [REMOTE]);

		expect(state.active).toEqual([]);
		expect(stops(effects)).toEqual([REMOTE]);
		expect(said(effects)).toEqual(["Stopped one session on Build box that isn't active."]);
	});

	it('every reconnect → matched again; nothing started twice', () => {
		const first = resynced(known([{ type: 'activate', ref: REMOTE }]), []);
		const again = run(
			[
				{ type: 'machine_status', id: 'vm1', status: 'unreachable', detail: 'timeout' },
				{ type: 'machine_resynced', id: 'vm1', inputs: [] },
			],
			{ start: first.state },
		);

		expect(starts(first.effects)).toEqual([REMOTE]);
		// Still starting: the first start is under way.
		expect(starts(again.effects)).toEqual([]);
	});
});
