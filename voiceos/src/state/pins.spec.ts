import { describe, expect, it } from 'bun:test';
import type { Input, State } from '../shared/protocol.js';
import { parentView } from '../shared/machines.js';
import { run, worktree } from '../../test/support/reduce.js';

const VM1 = { id: 'vm1', host: 'dev@vm1.example.com', name: 'Build box' };
const REMOTE = 'vm1:store/main';
const LOCAL = 'store/main';
const OTHER = 'store/wrk1';

// A main that knows vm1, connected, with a session there and two here.
const connected = (extra: Input[] = []): State =>
	run([
		{ type: 'machines', machines: [VM1] },
		{
			type: 'worktrees',
			worktrees: [worktree(LOCAL), worktree(OTHER), { ...worktree(REMOTE), label: 'store/main' }],
		},
		{ type: 'machine_resynced', id: 'vm1', inputs: [] },
		...extra,
	]).state;

describe('pin_session / unpin_session', () => {
	it('pin twice, then another → each once, in pin order', () => {
		const state = connected([
			{ type: 'pin_session', ref: REMOTE },
			{ type: 'pin_session', ref: REMOTE },
			{ type: 'pin_session', ref: LOCAL },
		]);

		expect(state.pinned).toEqual([REMOTE, LOCAL]);
	});

	it('pin a ref crew does not have → nothing', () => {
		expect(connected([{ type: 'pin_session', ref: 'store/wrk9' }]).pinned).toEqual([]);
	});

	it('unpin twice → gone, the rest keep their order', () => {
		const state = connected([
			{ type: 'pin_session', ref: REMOTE },
			{ type: 'pin_session', ref: LOCAL },
			{ type: 'pin_session', ref: OTHER },
			{ type: 'unpin_session', ref: LOCAL },
			{ type: 'unpin_session', ref: LOCAL },
		]);

		expect(state.pinned).toEqual([REMOTE, OTHER]);
	});

	it('unpin a pin whose session is gone → unpinned', () => {
		const state = connected([
			{ type: 'pin_session', ref: OTHER },
			{ type: 'worktrees', worktrees: [worktree(LOCAL)] },
			{ type: 'unpin_session', ref: OTHER },
		]);

		expect(state.pinned).toEqual([]);
	});

	it('pin a session of a machine out of reach → pinned, nothing said, nothing sent', () => {
		const { state, effects } = run(
			[
				{ type: 'machine_status', id: 'vm1', status: 'unreachable', detail: 'timeout' },
				{ type: 'pin_session', ref: REMOTE },
			],
			{ start: connected() },
		);

		expect(state.pinned).toEqual([REMOTE]);
		expect(effects).toEqual([]);
	});
});

describe('pinned_loaded', () => {
	it('saved pins + one made before they loaded → saved first, the early one after, no repeats', () => {
		const state = connected([
			{ type: 'pin_session', ref: OTHER },
			{ type: 'pinned_loaded', refs: [REMOTE, LOCAL, OTHER] },
		]);

		expect(state.pinned).toEqual([REMOTE, LOCAL, OTHER]);
	});

	it('a pin of a machine the state does not know → dropped; a gone local session → kept', () => {
		const state = connected([
			{ type: 'pinned_loaded', refs: ['gpu:store/main', REMOTE, 'store/wrk9'] },
		]);

		expect(state.pinned).toEqual([REMOTE, 'store/wrk9']);
	});
});

describe('a switch to a pinned session', () => {
	const pinned = (extra: Input[] = []): State =>
		connected([
			{ type: 'pin_session', ref: REMOTE },
			{ type: 'pin_session', ref: LOCAL },
			...extra,
		]);

	it('from Pinned, a machine grid, Mission Control or another session → opened from Pinned', () => {
		const starts: Input[] = [
			{ type: 'switch_view', view: { kind: 'pinned' } },
			{ type: 'switch_view', view: { kind: 'grid', machine: 'vm1' } },
			{ type: 'switch_view', view: { kind: 'machines' } },
			{ type: 'switch_view', view: { kind: 'session', ref: OTHER } },
		];

		for (const start of starts) {
			const state = pinned([
				start,
				{ type: 'switch_view', view: { kind: 'session', ref: REMOTE } },
			]);

			expect(state.view).toEqual({ kind: 'session', ref: REMOTE, from: 'pinned' });
		}
	});

	it('from one pinned session to another (a tab, a voice switch) → still from Pinned', () => {
		const state = pinned([
			{ type: 'switch_view', view: { kind: 'session', ref: REMOTE, from: 'pinned' } },
			{ type: 'switch_view', view: { kind: 'session', ref: LOCAL } },
		]);

		expect(state.view).toEqual({ kind: 'session', ref: LOCAL, from: 'pinned' });
	});

	it('to a session not pinned, even from inside Pinned or asked from Pinned → its machine', () => {
		const state = pinned([
			{ type: 'switch_view', view: { kind: 'session', ref: REMOTE } },
			{ type: 'switch_view', view: { kind: 'session', ref: OTHER, from: 'pinned' } },
		]);

		expect(state.view).toEqual({ kind: 'session', ref: OTHER });
		expect(parentView(state)).toEqual({ kind: 'grid', machine: 'local' });
	});

	it('unpin the open session → it stays open from Pinned, Esc goes to Pinned, its pin is gone', () => {
		const state = pinned([
			{ type: 'switch_view', view: { kind: 'session', ref: REMOTE } },
			{ type: 'unpin_session', ref: REMOTE },
		]);

		expect(state.view).toEqual({ kind: 'session', ref: REMOTE, from: 'pinned' });
		expect(parentView(state)).toEqual({ kind: 'pinned' });
		expect(state.pinned).toEqual([LOCAL]);
	});

	it('switch to Pinned → nothing said', () => {
		const { effects } = run([{ type: 'switch_view', view: { kind: 'pinned' } }], {
			start: pinned(),
		});

		expect(effects).toEqual([]);
	});
});

describe('a pinned session that goes away', () => {
	it('its worktree removed while open from Pinned → back to Pinned, the pin kept', () => {
		const state = connected([
			{ type: 'pin_session', ref: OTHER },
			{ type: 'switch_view', view: { kind: 'session', ref: OTHER } },
			{ type: 'worktrees', worktrees: [worktree(LOCAL)] },
		]);

		expect(state.view).toEqual({ kind: 'pinned' });
		expect(state.pinned).toEqual([OTHER]);
	});

	it('its worktree removed, opened from its machine → that machine grid, as before', () => {
		const state = connected([
			{ type: 'switch_view', view: { kind: 'session', ref: OTHER } },
			{ type: 'worktrees', worktrees: [worktree(LOCAL)] },
		]);

		expect(state.view).toEqual({ kind: 'grid', machine: 'local' });
	});

	it('remove_machine → its pins dropped, this Mac keeps its own; open from Pinned → Pinned', () => {
		const state = connected([
			{ type: 'pin_session', ref: REMOTE },
			{ type: 'pin_session', ref: LOCAL },
			{ type: 'switch_view', view: { kind: 'session', ref: REMOTE } },
			{ type: 'remove_machine', id: 'vm1' },
		]);

		expect(state.pinned).toEqual([LOCAL]);
		expect(state.view).toEqual({ kind: 'pinned' });
	});

	it('its machine gone from machines.json → its pins dropped', () => {
		const state = connected([
			{ type: 'pin_session', ref: REMOTE },
			{ type: 'pin_session', ref: LOCAL },
			{ type: 'machines', machines: [] },
		]);

		expect(state.pinned).toEqual([LOCAL]);
	});
});
