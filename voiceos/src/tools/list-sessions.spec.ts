import { describe, expect, it } from 'bun:test';
import type { Machine, State } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { MAX_NAMES_SAID, describeSessionList, listSessions } from './list-sessions.js';

const buildMachine = (patch: Partial<Machine> = {}): Machine => ({
	id: 'vm1',
	host: 'dev@vm1',
	name: 'Build box',
	status: 'connected',
	detail: null,
	since: 0,
	...patch,
});

// refs: every worktree crew has; active: the ones voice reaches; setup never is.
const createState = (refs: string[], patch: Partial<State> = {}): State => {
	const order = ['setup', ...refs];

	return {
		...createInitialState(),
		sessions: Object.fromEntries(
			order.map((ref) => [
				ref,
				createSession({
					ref,
					label: ref.replace(/^vm1:/, ''),
					branch: '',
					cwd: '/w',
					dirs: [],
					isPinned: ref === 'setup',
				}),
			]),
		),
		order,
		machines: { vm1: buildMachine() },
		active: [],
		...patch,
	};
};

// count worktrees on vm1, spread over the signals and admin workspaces.
const listRemoteWorktrees = (count: number): string[] =>
	Array.from(
		{ length: count },
		(_, index) => `vm1:${index % 2 === 0 ? 'signals' : 'admin'}/wrk${index + 1}`,
	);

describe('describeSessionList', () => {
	it('machines → each with its worktrees and how many are active; one out of reach said so', () => {
		const state = createState(['store-front/main', 'store-front/wrk1', 'vm1:signals/wrk1'], {
			active: ['store-front/main'],
			machines: {
				vm1: buildMachine(),
				vm2: buildMachine({ id: 'vm2', name: 'Spare', status: 'unreachable' }),
			},
		});

		expect(
			describeSessionList({ state, machine: null, workspace: null, isActiveOnly: false }),
		).toBe(
			'This Mac: 2 worktrees, 1 active; Build box: 1 worktree, 0 active; Spare: no worktrees, 0 active, out of reach.',
		);
	});

	it(`one machine with at most ${MAX_NAMES_SAID} worktrees → their names, the active ones marked`, () => {
		const state = createState(listRemoteWorktrees(MAX_NAMES_SAID), {
			active: ['vm1:admin/wrk2'],
		});

		expect(
			describeSessionList({ state, machine: 'vm1', workspace: null, isActiveOnly: false }),
		).toBe(
			'Build box has signals, work 1, admin, work 2 (active), signals, work 3, admin, work 4, signals, work 5, admin, work 6.',
		);
	});

	it(`one machine with more than ${MAX_NAMES_SAID} → counts and its workspaces, then "which workspace?"`, () => {
		const state = createState(listRemoteWorktrees(MAX_NAMES_SAID + 1));

		expect(
			describeSessionList({ state, machine: 'vm1', workspace: null, isActiveOnly: false }),
		).toBe(
			'Build box has 7 worktrees in 2 workspaces; none active. Workspaces: signals, admin. Ask which workspace.',
		);
	});

	it('a machine with no worktrees → said so', () => {
		const state = createState(['store-front/main']);

		expect(
			describeSessionList({ state, machine: 'vm1', workspace: null, isActiveOnly: false }),
		).toBe('Build box has no worktrees.');
	});

	it('a machine out of reach → named as such, with what was last known', () => {
		const state = createState(['vm1:signals/wrk1'], {
			machines: { vm1: buildMachine({ status: 'unreachable' }) },
		});

		expect(
			describeSessionList({ state, machine: 'vm1', workspace: null, isActiveOnly: false }),
		).toBe('Build box is out of reach; last known: Build box has signals, work 1.');
	});

	it('one workspace → its worktrees, its machine said once when they share one', () => {
		const state = createState([...listRemoteWorktrees(3), 'store-front/main']);

		expect(
			describeSessionList({ state, machine: null, workspace: 'signals', isActiveOnly: false }),
		).toBe('signals on Build box has signals, work 1, signals, work 3.');
	});

	it('one workspace on two machines → each worktree with its machine', () => {
		const state = createState(['store-front/main', 'vm1:store-front/main']);

		expect(
			describeSessionList({ state, machine: null, workspace: 'store front', isActiveOnly: false }),
		).toBe('store front has store front, main, Build box store front, main.');
	});

	it(`the active ones, at most ${MAX_NAMES_SAID} → named, another machine's with it, never setup`, () => {
		const remote = listRemoteWorktrees(MAX_NAMES_SAID - 1);
		// A setup stored in the set by an earlier release is still not one.
		const state = createState(remote, { active: [...remote, 'setup'] });

		expect(describeSessionList({ state, machine: null, workspace: null, isActiveOnly: true })).toBe(
			'Active: Build box signals, work 1, Build box admin, work 2, Build box signals, work 3, Build box admin, work 4, Build box signals, work 5.',
		);
	});

	it('no active ones → says so, never an empty list', () => {
		const state = createState(['store-front/main'], { active: [] });

		expect(describeSessionList({ state, machine: null, workspace: null, isActiveOnly: true })).toBe(
			'No sessions are active. A worktree is reached once it is activated.',
		);
	});

	it(`the active ones, more than ${MAX_NAMES_SAID} → a count and how many machines`, () => {
		const remote = listRemoteWorktrees(MAX_NAMES_SAID);
		const state = createState([...remote, 'store-front/main'], {
			active: [...remote, 'store-front/main'],
		});

		expect(describeSessionList({ state, machine: null, workspace: null, isActiveOnly: true })).toBe(
			'7 sessions are active, on 2 machines.',
		);
	});
});

describe('listSessions', () => {
	it('a machine as said → that machine, said in a few words', () => {
		const state = createState(['vm1:signals/wrk1']);

		expect(listSessions(state, { machine: 'the build box' })).toEqual({
			ok: true,
			content: 'Build box has signals, work 1. Say this in a few words.',
		});
	});

	it('a machine nobody has → fails, naming the machines there are', () => {
		expect(listSessions(createState([]), { machine: 'gpu box' })).toEqual({
			ok: false,
			content: 'No machine called gpu box. Machines: This Mac, Build box.',
		});
	});
});
