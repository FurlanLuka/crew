import { describe, expect, it } from 'bun:test';
import type { Input, SessionGroup, State } from '../shared/protocol.js';
import { run, worktree } from '../../test/support/reduce.js';

const VM1 = { id: 'vm1', host: 'dev@vm1.example.com', name: 'Build box' };
const A = 'store/main';
const B = 'store/wrk1';
const C = 'admin/main';
const D = 'infra/main';
const R = 'vm1:store/wrk2';

const remoteWorktree = (ref: string) => ({ ...worktree(ref), label: ref.slice('vm1:'.length) });

// A main that knows vm1 (connected), with A, B, C, D here and R there, all active in that order.
const booted = (extra: Input[] = []): State =>
	run([
		{ type: 'machines', machines: [VM1] },
		{
			type: 'worktrees',
			worktrees: [worktree(A), worktree(B), worktree(C), worktree(D), remoteWorktree(R)],
		},
		{ type: 'machine_resynced', id: 'vm1', inputs: [] },
		...[A, B, C, D, R].map((ref): Input => ({ type: 'activate', ref })),
		...extra,
	]).state;

const create = (target: string, dragged: string, name = 'store'): Input => ({
	type: 'create_group',
	refs: [target, dragged],
	name,
	color: 'blue',
});

const then = (state: State, inputs: Input[]): State => run(inputs, { start: state }).state;

const membersOf = (state: State): Record<string, string[]> =>
	Object.fromEntries(state.groups.map((group) => [group.name, group.refs]));

describe('create_group', () => {
	it('a tab dropped on a loose tab → a group of the two, the dropped one right after the other', () => {
		const state = booted([create(A, C)]);

		expect(state.groups).toEqual([{ id: 'g1', name: 'store', color: 'blue', refs: [A, C] }]);
		expect(state.active).toEqual([A, C, B, D, R]);
	});

	it('the name is kept folded; ids go g1, g2', () => {
		const state = booted([create(A, B, '  my   store '), create(C, D, 'ops')]);

		expect(state.groups.map((group) => [group.id, group.name])).toEqual([
			['g1', 'my store'],
			['g2', 'ops'],
		]);
	});

	it('the dropped one leaves its old group, which dissolves when one is left', () => {
		const state = booted([create(A, B), create(C, B, 'mixed')]);

		expect(membersOf(state)).toEqual({ mixed: [C, B] });
	});

	it('the dropped tab before the target in the bar → it moves to just after the target', () =>
		expect(booted([create(C, A)]).active).toEqual([B, C, A, D, R]));

	it('the same tab twice, an inactive one, a setup session, a grouped target or no name → nothing', () => {
		const start = booted([create(A, B)]);
		const inactive = then(start, [{ type: 'deactivate', ref: D }]);

		expect(then(start, [create(C, C)]).groups).toBe(start.groups);
		expect(then(inactive, [create(C, D)]).groups).toBe(inactive.groups);
		expect(then(start, [create(C, 'setup')]).groups).toBe(start.groups);
		expect(then(start, [create(A, C)]).groups).toBe(start.groups);
		expect(then(start, [create(C, D, '   ')]).groups).toBe(start.groups);
	});

	it('a session on a machine out of reach is grouped like any other, and nothing is said or started', () => {
		const away = booted([{ type: 'machine_status', id: 'vm1', status: 'unreachable' }]);
		const result = run([create(A, R)], { start: away });

		expect(membersOf(result.state)).toEqual({ store: [A, R] });
		expect(result.effects).toEqual([]);
	});
});

describe('join, leave, update, ungroup', () => {
	it('join → the group takes it at its end, moved next to the others; from another group, it leaves that one', () => {
		const start = booted([create(A, B), create(C, D, 'ops')]);
		const state = then(start, [{ type: 'join_group', id: 'g1', ref: R }]);

		expect(membersOf(state)).toEqual({ store: [A, B, R], ops: [C, D] });
		expect(state.active).toEqual([A, B, R, C, D]);

		expect(membersOf(then(start, [{ type: 'join_group', id: 'g1', ref: C }]))).toEqual({
			store: [A, B, C],
		});
	});

	it('join an unknown group, one it is in, or with an inactive or setup session → nothing', () => {
		const start = booted([create(A, B)]);
		const inactive = then(start, [{ type: 'deactivate', ref: C }]);

		expect(then(inactive, [{ type: 'join_group', id: 'g1', ref: C }]).groups).toBe(inactive.groups);
		expect(then(start, [{ type: 'join_group', id: 'g1', ref: 'setup' }]).groups).toBe(start.groups);

		expect(then(start, [{ type: 'join_group', id: 'g9', ref: C }]).groups).toBe(start.groups);
		expect(then(start, [{ type: 'join_group', id: 'g1', ref: A }]).groups).toBe(start.groups);
	});

	it('leave → it is a plain tab after the group; the last two → the group is gone', () => {
		const start = booted([create(A, B), { type: 'join_group', id: 'g1', ref: C }]);
		const left = then(start, [{ type: 'leave_group', ref: A }]);

		expect(membersOf(left)).toEqual({ store: [B, C] });
		expect(left.active).toEqual([B, C, A, D, R]);
		expect(then(left, [{ type: 'leave_group', ref: B }]).groups).toEqual([]);
	});

	it('update → a new name and colour; an empty name keeps the old one', () => {
		const start = booted([create(A, B)]);
		const [renamed] = then(start, [{ type: 'update_group', id: 'g1', name: 'shop', color: 'pink' }])
			.groups as [SessionGroup];
		const [kept] = then(start, [{ type: 'update_group', id: 'g1', name: '  ' }]).groups as [
			SessionGroup,
		];

		expect([renamed.name, renamed.color]).toEqual(['shop', 'pink']);
		expect(kept.name).toBe('store');
	});

	it('update or ungroup an unknown group → nothing', () => {
		const start = booted([create(A, B)]);

		expect(then(start, [{ type: 'update_group', id: 'g7', name: 'x' }]).groups).toBe(start.groups);
		expect(then(start, [{ type: 'ungroup', id: 'g7' }]).groups).toEqual(start.groups);
	});

	it('a colour alone → the name kept', () => {
		const [recoloured] = then(booted([create(A, B)]), [
			{ type: 'update_group', id: 'g1', color: 'sand' },
		]).groups as [SessionGroup];

		expect([recoloured.name, recoloured.color]).toEqual(['store', 'sand']);
	});

	it('ungroup → its tabs are plain again and it is closed', () => {
		const state = booted([
			create(A, B),
			{ type: 'open_group', id: 'g1' },
			{ type: 'ungroup', id: 'g1' },
		]);

		expect(state.groups).toEqual([]);
		expect(state.openGroup).toBeNull();
	});
});

describe('every way a member leaves', () => {
	it('deactivated → out of its group; a group left with one dissolves; activated again → ungrouped', () => {
		const state = booted([
			create(A, B),
			{ type: 'deactivate', ref: B },
			{ type: 'activate', ref: B },
		]);

		expect(state.groups).toEqual([]);
	});

	it('its machine removed → its sessions leave their groups', () => {
		const state = booted([
			create(A, R),
			create(C, D, 'ops'),
			{ type: 'remove_machine', id: 'vm1' },
		]);

		expect(membersOf(state)).toEqual({ ops: [C, D] });
	});

	it('its machine gone from machines.json → the same', () => {
		const state = booted([create(A, R), { type: 'machines', machines: [] }]);

		expect(state.groups).toEqual([]);
	});

	it('a machine out of reach → its sessions stay in their groups', () => {
		const state = booted([
			create(A, R),
			{ type: 'machine_status', id: 'vm1', status: 'unreachable' },
		]);

		expect(membersOf(state)).toEqual({ store: [A, R] });
	});
});

describe('the open group', () => {
	const open = (extra: Input[] = []): State =>
		booted([
			create(A, B),
			{ type: 'switch_view', view: { kind: 'session', ref: A } },
			{ type: 'open_group', id: 'g1' },
			...extra,
		]);

	it('opened, and closed with null; an unknown group is never opened', () => {
		expect(open().openGroup).toBe('g1');
		expect(open([{ type: 'open_group', id: null }]).openGroup).toBeNull();
		expect(booted([{ type: 'open_group', id: 'g4' }]).openGroup).toBeNull();
	});

	it('a session of the group on screen → stays open; Home → stays open', () => {
		expect(open([{ type: 'switch_view', view: { kind: 'session', ref: B } }]).openGroup).toBe('g1');
		expect(open([{ type: 'switch_view', view: { kind: 'active' } }]).openGroup).toBe('g1');
	});

	it('a session outside it comes on screen (a click, voice, go back) → closed', () => {
		expect(open([{ type: 'switch_view', view: { kind: 'session', ref: C } }]).openGroup).toBeNull();

		const backFromC = booted([
			create(A, B),
			{ type: 'switch_view', view: { kind: 'session', ref: C } },
			{ type: 'switch_view', view: { kind: 'session', ref: A } },
			{ type: 'open_group', id: 'g1' },
			{ type: 'go_back' },
		]);

		expect(backFromC.view).toEqual({ kind: 'session', ref: C, from: 'active' });
		expect(backFromC.openGroup).toBeNull();
	});

	it('opened while a session outside it is on screen → open; it closes at the next view change', () => {
		const state = booted([
			create(A, B),
			{ type: 'switch_view', view: { kind: 'session', ref: C } },
			{ type: 'open_group', id: 'g1' },
		]);

		expect(state.openGroup).toBe('g1');
	});

	it('a session activated meanwhile → closed, so its new tab shows', () => {
		const state = open([
			{ type: 'deactivate', ref: D },
			{ type: 'open_group', id: 'g1' },
			{ type: 'activate', ref: D },
		]);

		expect(state.openGroup).toBeNull();
	});

	it('its group dissolved → closed', () =>
		expect(open([{ type: 'leave_group', ref: B }]).openGroup).toBeNull());
});

describe('order', () => {
	it('move_active into the middle of a group → it lands after the group', () => {
		const state = booted([
			create(A, B),
			{ type: 'join_group', id: 'g1', ref: C },
			{ type: 'move_active', ref: D, before: B },
		]);

		expect(state.active).toEqual([A, B, C, D, R]);
	});

	it('a member moved inside its group (the open box) → the new order holds', () => {
		const state = booted([
			create(A, B),
			{ type: 'join_group', id: 'g1', ref: C },
			{ type: 'move_active', ref: C, before: A },
		]);

		expect(state.active).toEqual([C, A, B, D, R]);
		expect(membersOf(state)).toEqual({ store: [C, A, B] });
	});

	it('a member moved to the end (after the last tab of the open box) → the end of its group, which stays put', () => {
		const state = booted([create(A, B), { type: 'move_active', ref: A, before: null }]);

		expect(state.active).toEqual([B, A, C, D, R]);
	});

	it('move_group → the whole group before a ref, or the end', () => {
		const start = booted([create(A, B)]);

		expect(then(start, [{ type: 'move_group', id: 'g1', before: R }]).active).toEqual([
			C,
			D,
			A,
			B,
			R,
		]);
		expect(then(start, [{ type: 'move_group', id: 'g1', before: null }]).active).toEqual([
			C,
			D,
			R,
			A,
			B,
		]);
	});

	it('move_group before its own member → nothing; before the middle of another group → before that group', () => {
		const start = booted([
			create(A, B),
			create(C, D, 'ops'),
			{ type: 'join_group', id: 'g2', ref: R },
		]);

		expect(then(start, [{ type: 'move_group', id: 'g1', before: B }]).active).toBe(start.active);
		expect(then(start, [{ type: 'move_group', id: 'g2', before: B }]).active).toEqual([
			C,
			D,
			R,
			A,
			B,
		]);
		// Before R, in the middle of ops: before ops, where it already is.
		expect(then(start, [{ type: 'move_group', id: 'g1', before: R }]).active).toBe(start.active);
	});
});

describe('groups_loaded', () => {
	const saved = (id: string, refs: string[], name = id): SessionGroup => ({
		id,
		name,
		color: 'teal',
		refs,
	});

	it('the saved groups and the open one; members no longer active dropped, a group left alone gone', () => {
		const state = booted([
			{ type: 'deactivate', ref: D },
			{
				type: 'groups_loaded',
				groups: [saved('g1', [A, B]), saved('g2', [C, D])],
				openGroup: 'g1',
			},
		]);

		expect(membersOf(state)).toEqual({ g1: [A, B] });
		expect(state.openGroup).toBe('g1');
	});

	it('a group made since boot wins: a saved ref it holds is dropped, a saved id it uses renumbered', () => {
		const state = booted([
			create(A, B, 'new'),
			{
				type: 'groups_loaded',
				groups: [saved('g1', [B, C, D], 'old')],
				openGroup: null,
			},
		]);

		expect(state.groups.map((group) => [group.id, group.name, group.refs])).toEqual([
			['g1', 'new', [A, B]],
			['g2', 'old', [C, D]],
		]);
	});

	it('a saved open group whose id a new group took → the saved one opens under its new id', () => {
		const state = booted([
			create(A, B, 'new'),
			{ type: 'groups_loaded', groups: [saved('g1', [C, D], 'old')], openGroup: 'g1' },
		]);

		expect(state.openGroup).toBe('g2');
		expect(state.groups.find((group) => group.id === 'g2')?.name).toBe('old');
	});

	it('a group opened since boot stays open over the saved one', () => {
		const state = booted([
			create(A, B, 'new'),
			{ type: 'open_group', id: 'g1' },
			{ type: 'groups_loaded', groups: [saved('g5', [C, D], 'old')], openGroup: 'g5' },
		]);

		expect(state.openGroup).toBe('g1');
	});

	it('a saved open group that did not survive → none open', () => {
		const state = booted([
			{ type: 'deactivate', ref: B },
			{ type: 'groups_loaded', groups: [saved('g1', [A, B])], openGroup: 'g1' },
		]);

		expect(state.openGroup).toBeNull();
	});
});
