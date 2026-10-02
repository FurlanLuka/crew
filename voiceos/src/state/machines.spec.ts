import { describe, expect, it } from 'bun:test';
import type { Input, State, View } from '../shared/protocol.js';
import { run, worktree } from '../../test/support/reduce.js';

const VM1 = { id: 'vm1', host: 'dev@vm1.example.com', name: 'Build box' };
const REMOTE = 'vm1:store/main';

// A main that knows vm1, connected, with one active idle session there and one inactive here.
const connected = (extra: Input[] = []): State =>
	run([
		{ type: 'machines', machines: [VM1] },
		{
			type: 'worktrees',
			worktrees: [worktree('store/main'), { ...worktree(REMOTE), label: 'store/main' }],
		},
		{ type: 'activate', ref: REMOTE },
		{ type: 'machine_resynced', id: 'vm1', inputs: [{ type: 'session_started', ref: REMOTE }] },
		...extra,
	]).state;

describe('machines', () => {
	it('config → each machine connecting, keyed by id', () => {
		const { state } = run([{ type: 'machines', machines: [VM1] }]);

		expect(state.machines.vm1).toMatchObject({ ...VM1, status: 'connecting', detail: null });
	});

	it('a rename from the file keeps the status', () => {
		const state = connected([{ type: 'machines', machines: [{ ...VM1, name: 'GPU box' }] }]);

		expect(state.machines.vm1).toMatchObject({ name: 'GPU box', status: 'connected' });
	});

	it('a machine gone from the file → its sessions leave, this Mac keeps its own', () => {
		const state = connected([{ type: 'machines', machines: [] }]);

		expect(state.order).toEqual(['store/main']);
		expect(state.machines).toEqual({});
	});
});

describe('add_machine / rename_machine / remove_machine', () => {
	it('add → an id from the host, the name given, saved', () => {
		const { state, effects } = run([
			{ type: 'add_machine', host: 'dev@vm1.example.com', name: 'Build box' },
		]);

		expect(state.machines.vm1).toMatchObject({ id: 'vm1', name: 'Build box' });
		expect(effects).toEqual([
			{ type: 'machines_changed', change: { kind: 'add', host: VM1.host, name: 'Build box' } },
		]);
	});

	it('add without a name → named by its id', () => {
		const { state } = run([{ type: 'add_machine', host: 'gpu' }]);

		expect(state.machines.gpu?.name).toBe('gpu');
	});

	it('add the same host again → refused aloud, nothing saved', () => {
		const { effects } = run([
			{ type: 'add_machine', host: VM1.host },
			{ type: 'add_machine', host: VM1.host },
		]);

		expect(effects).toEqual([
			expect.objectContaining({
				type: 'speak',
				text: 'vm1 already connects to dev@vm1.example.com.',
			}),
		]);
	});

	it('add a host ssh would read as an option → nothing', () => {
		const { state, effects } = run([{ type: 'add_machine', host: '-oProxyCommand=x' }]);

		expect(state.machines).toEqual({});
		expect(effects).toEqual([]);
	});

	it('rename → saved with the new name', () => {
		const { effects } = run([{ type: 'rename_machine', id: 'vm1', name: 'GPU box' }], {
			start: connected(),
		});

		expect(effects).toEqual([
			{ type: 'machines_changed', change: { kind: 'rename', id: 'vm1', name: 'GPU box' } },
		]);
	});

	it('remove with words waiting for it → saved, and the dropped words said', () => {
		const offline = connected([
			{ type: 'machine_status', id: 'vm1', status: 'unreachable', detail: 'The link closed.' },
			{ type: 'send', ref: REMOTE, text: 'run the tests' },
		]);
		const { state, effects } = run([{ type: 'remove_machine', id: 'vm1' }], { start: offline });

		expect(state.sessions[REMOTE]).toBeUndefined();
		expect(effects).toEqual([
			{ type: 'machines_changed', change: { kind: 'remove', id: 'vm1' } },
			expect.objectContaining({ text: 'Removed Build box. Messages waiting for it were dropped.' }),
		]);
	});

	it('remove the machine on screen → back home to Active, from Activate or a session', () => {
		const removeFrom = (view: View): View =>
			run(
				[
					{ type: 'switch_view', view },
					{ type: 'remove_machine', id: 'vm1' },
				],
				{ start: connected() },
			).state.view;

		expect(removeFrom({ kind: 'activate', machine: 'vm1' })).toEqual({ kind: 'active' });
		expect(removeFrom({ kind: 'session', ref: REMOTE })).toEqual({ kind: 'active' });
	});
});

describe('machine_status', () => {
	it('unreachable → recorded with why', () => {
		const state = connected([
			{ type: 'machine_status', id: 'vm1', status: 'unreachable', detail: 'Host vm1 not found.' },
		]);

		expect(state.machines.vm1).toMatchObject({
			status: 'unreachable',
			detail: 'Host vm1 not found.',
		});
	});

	it('connected is never taken from a status: only a resync makes it', () => {
		const state = run([
			{ type: 'machines', machines: [VM1] },
			{ type: 'machine_status', id: 'vm1', status: 'connected' },
		]).state;

		expect(state.machines.vm1?.status).toBe('connecting');
	});
});

describe('machine_resynced', () => {
	const offlineWithQueue = (): State =>
		connected([
			{ type: 'send', ref: REMOTE, text: 'refactor the router' },
			{ type: 'machine_status', id: 'vm1', status: 'unreachable' },
			{ type: 'send', ref: REMOTE, text: 'then run the tests' },
		]);

	it('a turn that ended out of reach → reported quietly, the queue head sent once', () => {
		const { state, effects } = run(
			[
				{
					type: 'machine_resynced',
					id: 'vm1',
					inputs: [
						{
							type: 'turn_ended',
							ref: REMOTE,
							costUsd: 0.2,
							text: 'Refactored.',
							turnId: 't1',
							head: 'abc123',
						},
					],
				},
			],
			{ start: offlineWithQueue() },
		);

		expect(state.machines.vm1?.status).toBe('connected');
		expect(state.sessions[REMOTE]).toMatchObject({
			status: 'running',
			lastTurnId: 't1',
			queue: [],
		});
		expect(effects.filter((effect) => effect.type === 'narrate')).toEqual([
			expect.objectContaining({ ref: REMOTE, isQuiet: true, head: 'abc123' }),
		]);
		expect(effects.filter((effect) => effect.type === 'worker_send')).toEqual([
			{ type: 'worker_send', ref: REMOTE, text: 'then run the tests' },
		]);
		expect(effects.some((effect) => effect.type === 'speak')).toBe(false);
	});

	it('nothing new there → connected, the waiting words go', () => {
		const idleOffline = connected([
			{ type: 'machine_status', id: 'vm1', status: 'unreachable' },
			{ type: 'send', ref: REMOTE, text: 'run the tests' },
		]);
		const { effects } = run([{ type: 'machine_resynced', id: 'vm1', inputs: [] }], {
			start: idleOffline,
		});

		expect(effects).toEqual([{ type: 'worker_send', ref: REMOTE, text: 'run the tests' }]);
	});
});

describe('guardUnreachable', () => {
	const offline = (): State =>
		connected([
			{ type: 'machine_status', id: 'vm1', status: 'unreachable', detail: 'The link closed.' },
		]);

	it('words for a machine out of reach → queued, and said so; nothing sent', () => {
		const { state, effects } = run([{ type: 'send', ref: REMOTE, text: 'run the tests' }], {
			start: offline(),
		});

		expect(state.sessions[REMOTE]?.queue.map((message) => message.text)).toEqual(['run the tests']);
		expect(effects).toEqual([
			expect.objectContaining({
				type: 'speak',
				text: "Build box is out of reach. I'll send it when it's back.",
			}),
		]);
	});

	it('anything else for it → refused aloud, state untouched', () => {
		const start = offline();

		for (const input of [
			{ type: 'interrupt', ref: REMOTE },
			{ type: 'dev_start', ref: REMOTE },
		] satisfies Input[]) {
			const { state, effects } = run([input], { start });

			expect(state.sessions).toEqual(start.sessions);
			expect(effects).toEqual([
				expect.objectContaining({ type: 'speak', text: 'Build box is out of reach right now.' }),
			]);
		}
	});

	it('this Mac is never guarded', () => {
		const stopped = run(
			[
				{ type: 'activate', ref: 'store/main' },
				{ type: 'worker_exited', ref: 'store/main', error: null },
			],
			{ start: offline() },
		).state;
		const { effects } = run([{ type: 'send', ref: 'store/main', text: 'hello' }], {
			start: stopped,
		});

		expect(effects).toEqual([{ type: 'worker_start', ref: 'store/main' }]);
	});
});

describe('switch_view to a machine', () => {
	it('from elsewhere, nothing waiting → nothing said', () => {
		const { effects } = run([{ type: 'switch_view', view: { kind: 'activate', machine: 'vm1' } }], {
			start: connected(),
		});

		expect(effects).toEqual([]);
	});

	it('from elsewhere, a session there waiting → names it', () => {
		const start: State = {
			...connected(),
			asks: [{ id: 'a', ref: REMOTE, at: 1, kind: 'plan', input: {}, plan: 'p' }],
		};
		const { effects } = run([{ type: 'switch_view', view: { kind: 'activate', machine: 'vm1' } }], {
			start,
		});

		expect(effects).toEqual([
			expect.objectContaining({ type: 'speak', text: 'Build box. store/main is waiting on you.' }),
		]);
	});

	it('up from one of its sessions → nothing more to say', () => {
		const { effects } = run(
			[
				{ type: 'switch_view', view: { kind: 'session', ref: REMOTE } },
				{ type: 'switch_view', view: { kind: 'activate', machine: 'vm1' } },
			],
			{ start: connected() },
		);

		expect(effects).toEqual([]);
	});
});

describe('words waiting for a stopped session there', () => {
	it('sent while out of reach to a stopped session → on reconnect it is started, and its start sends them', () => {
		const offline = run([
			{ type: 'machines', machines: [VM1] },
			{ type: 'worktrees', worktrees: [{ ...worktree(REMOTE), label: 'store/main' }] },
			{ type: 'machine_resynced', id: 'vm1', inputs: [] },
			{ type: 'machine_status', id: 'vm1', status: 'unreachable' },
			// Activated while out of reach: added to the set, started once it is back.
			{ type: 'activate', ref: REMOTE },
			{ type: 'send', ref: REMOTE, text: 'run the tests' },
		]).state;
		const back = run([{ type: 'machine_resynced', id: 'vm1', inputs: [] }], { start: offline });

		// Once: the matching-up after the drain finds it starting already.
		expect(back.effects).toEqual([{ type: 'worker_start', ref: REMOTE }]);

		const started = run([{ type: 'session_started', ref: REMOTE }], { start: back.state });

		expect(started.effects).toEqual([{ type: 'worker_send', ref: REMOTE, text: 'run the tests' }]);
	});

	it('the session is not active → on reconnect it is not started; the words keep waiting', () => {
		const offline = run([
			{ type: 'machines', machines: [VM1] },
			{ type: 'worktrees', worktrees: [{ ...worktree(REMOTE), label: 'store/main' }] },
			{ type: 'machine_resynced', id: 'vm1', inputs: [] },
			{ type: 'machine_status', id: 'vm1', status: 'unreachable' },
			{ type: 'send', ref: REMOTE, text: 'run the tests' },
		]).state;
		const back = run([{ type: 'machine_resynced', id: 'vm1', inputs: [] }], { start: offline });

		expect(back.effects).toEqual([]);
		expect(back.state.sessions[REMOTE]?.status).toBe('stopped');
		expect(back.state.sessions[REMOTE]?.queue.map((message) => message.text)).toEqual([
			'run the tests',
		]);
	});
});

describe('answers to what Voice OS holds, for a machine out of reach', () => {
	it('a yes to a held /clear there → refused aloud, the ask kept', () => {
		const held = connected([
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
			{ type: 'machine_status', id: 'vm1', status: 'unreachable' },
		]);
		const { state, effects } = run(
			[{ type: 'answer_command', askId: 'held-1', isApproved: true }],
			{
				start: held,
			},
		);

		expect(state.asks.map((ask) => ask.id)).toEqual(['held-1']);
		expect(effects).toEqual([
			expect.objectContaining({ text: 'Build box is out of reach right now.' }),
		]);
	});
});

describe('removing the machine on screen, others left', () => {
	it('→ Active, not Activate for every machine', () => {
		const { state } = run([
			{ type: 'machines', machines: [VM1, { id: 'vm2', host: 'vm2', name: 'GPU box' }] },
			{ type: 'switch_view', view: { kind: 'activate', machine: 'vm1' } },
			{ type: 'remove_machine', id: 'vm1' },
		]);

		expect(state.view).toEqual({ kind: 'active' });
	});
});

describe('home', () => {
	it('a start → home is Active', () => {
		expect(run([]).state.view).toEqual({ kind: 'active' });
	});

	it('this Mac first, then each machine; the setup session leads within one', () => {
		const { state } = run([
			{ type: 'machines', machines: [VM1] },
			{
				type: 'worktrees',
				worktrees: [
					{ ...worktree('vm1:setup'), isPinned: true },
					worktree('vm1:a/main'),
					worktree('b/main'),
					{ ...worktree('setup'), isPinned: true },
				],
			},
		]);

		expect(state.order).toEqual(['setup', 'b/main', 'vm1:setup', 'vm1:a/main']);
	});
});

describe('adding or removing machines moves nobody', () => {
	const GPU = { id: 'gpu', host: 'gpu', name: 'GPU box' };

	it('a session or a machine on Activate on screen → stays through a reload, a rename and another add', () => {
		for (const view of [
			{ kind: 'session' as const, ref: REMOTE, from: 'active' as const },
			{ kind: 'activate' as const, machine: 'vm1' },
		]) {
			const { state } = run(
				[
					{ type: 'switch_view', view },
					{ type: 'machines', machines: [VM1] },
					{ type: 'rename_machine', id: 'vm1', name: 'Render box' },
					{ type: 'machines', machines: [VM1, GPU] },
				],
				{ start: connected() },
			);

			expect(state.view).toEqual(view);
		}
	});

	it('the last machine removed while on Active → still Active', () => {
		const { state } = run([{ type: 'machines', machines: [] }], { start: connected() });

		expect(state.view).toEqual({ kind: 'active' });
	});
});
