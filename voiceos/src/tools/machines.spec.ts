import { englishJudge } from '../../test/support/english-judge.js';
import { describe, expect, it } from 'bun:test';
import type { Action, Machine, State } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { createNullNotes } from '../../test/support/notes.js';
import { executeTool, type ToolContext } from './tools.js';
import { findMachine, findMachineSaid } from './machines.js';
import { listToolsFor } from './definitions.js';
import { describeSession } from './session-view.js';

const buildMachine = (patch: Partial<Machine> = {}): Machine => ({
	id: 'vm1',
	host: 'dev@vm1',
	name: 'Build box',
	status: 'connected',
	detail: null,
	since: 0,
	...patch,
});

const createContext = (patch: Partial<State> = {}) => {
	const refs = ['store/main', 'vm1:store/main'];
	const state: State = {
		...createInitialState(),
		sessions: Object.fromEntries(
			refs.map((ref) => [
				ref,
				createSession({
					ref,
					label: 'store/main',
					branch: '',
					cwd: '/w',
					dirs: [],
					isPinned: false,
				}),
			]),
		),
		order: refs,
		machines: { vm1: buildMachine() },
		...patch,
		// Every session active unless the test says which are.
		active: patch.active ?? patch.order ?? refs,
	};
	const actions: Action[] = [];
	const tools: ToolContext = {
		getState: () => state,
		dispatch: (action) => actions.push(action),
		readHistory: () => [],
		now: () => 0,
		asks: state.asks,
		mute: () => {},
		saveDebugNote: () => {},
		judge: englishJudge,
		notes: createNullNotes(),
		setListenMode: () => 'changed' as const,
		openUrl: () => true,
	};

	return { state, tools, actions };
};

describe('findMachine', () => {
	const { state } = createContext();

	it('its name as said, or its id → that machine', () => {
		expect(findMachine(state, 'the build box')).toBe('vm1');
		expect(findMachine(state, 'VM1')).toBe('vm1');
	});

	it('this Mac → local; anything else → none', () => {
		expect(findMachine(state, 'this Mac')).toBe('local');
		expect(findMachine(state, 'gpu box')).toBeNull();
	});
});

describe('switch_view with a machine', () => {
	it("go to build box → that machine's grid", async () => {
		const { tools, actions } = createContext();

		await executeTool('switch_view', { ref: null, machine: 'build box' }, tools);

		expect(actions).toEqual([{ type: 'switch_view', view: { kind: 'grid', machine: 'vm1' } }]);
	});

	it('a machine with nothing waiting, by machine or named as the ref → the kernel says nothing', async () => {
		const { tools } = createContext();

		for (const input of [{ ref: null, machine: 'build box' }, { ref: 'Build box' }]) {
			expect((await executeTool('switch_view', input, tools)).content).toBe(
				'switched to that machine; nothing waits there — say nothing',
			);
		}
	});

	it('a machine with a session waiting → Voice OS names it, the kernel still says nothing', async () => {
		const { tools } = createContext({
			asks: [{ id: 'a', ref: 'vm1:store/main', at: 1, kind: 'plan', input: {}, plan: 'p' }],
		});
		const result = await executeTool('switch_view', { ref: null, machine: 'build box' }, tools);

		expect(result.content).toBe(
			'switched to that machine; Voice OS says what waits there — say nothing',
		);
	});

	it('an unknown machine → nothing, and the machines named', async () => {
		const { tools, actions } = createContext();
		const result = await executeTool('switch_view', { ref: null, machine: 'gpu box' }, tools);

		expect(actions).toEqual([]);
		expect(result.content).toContain('Machines: this Mac, Build box');
	});

	it('home with machines → the machines view', async () => {
		const { tools, actions } = createContext();

		await executeTool('switch_view', { ref: null }, tools);

		expect(actions).toEqual([{ type: 'switch_view', view: { kind: 'machines' } }]);
	});
});

describe('rename_machine', () => {
	it('rename vm1 to GPU box → renamed', async () => {
		const { tools, actions } = createContext();

		await executeTool('rename_machine', { machine: 'vm1', name: ' GPU box ' }, tools);

		expect(actions).toEqual([{ type: 'rename_machine', id: 'vm1', name: 'GPU box' }]);
	});

	it('this Mac is not renamed', async () => {
		const { tools, actions } = createContext();
		const result = await executeTool('rename_machine', { machine: 'this Mac', name: 'x' }, tools);

		expect(actions).toEqual([]);
		expect(result.ok).toBe(false);
	});
});

describe('describeSession on another machine', () => {
	it('names the machine, and says when it is out of reach', () => {
		const { state } = createContext();
		const away = { ...state, machines: { vm1: buildMachine({ status: 'unreachable' }) } };

		expect(
			describeSession({ state, ref: 'vm1:store/main', isDetailed: false, now: 0 }),
		).toMatchObject({
			machine: 'Build box',
		});
		expect(
			describeSession({ state: away, ref: 'vm1:store/main', isDetailed: false, now: 0 }),
		).toMatchObject({
			machine: 'Build box',
			machine_out_of_reach: true,
		});
		expect(
			describeSession({ state, ref: 'store/main', isDetailed: false, now: 0 }),
		).not.toHaveProperty('machine');
	});
});

describe('remote notes', () => {
	const personal = (view: State['view']) => {
		const refs = ['crew/main', 'personal:cutgrid/wrk1', 'personal:sch/wrk1'];

		return createContext({
			sessions: Object.fromEntries(
				refs.map((ref) => [
					ref,
					createSession({
						ref,
						label: ref.replace(/^personal:/, ''),
						branch: '',
						cwd: '/w',
						dirs: [],
						isPinned: false,
					}),
				]),
			),
			order: refs,
			view,
			machines: {
				personal: {
					id: 'personal',
					host: 'personal',
					name: 'Personal',
					status: 'connected',
					detail: null,
					since: 0,
				},
			},
		});
	};

	it('"switch to personal server" → that machine, however the name was put', async () => {
		const { tools, actions } = personal({ kind: 'machines' });

		await executeTool('switch_view', { ref: null, machine: 'personal server' }, tools);
		await executeTool('switch_view', { ref: 'Personal' }, tools);

		expect(actions).toEqual([
			{ type: 'switch_view', view: { kind: 'grid', machine: 'personal' } },
			{ type: 'switch_view', view: { kind: 'grid', machine: 'personal' } },
		]);
	});

	it('in Personal, "activate the cloud session" → no worktree answers to it, nothing activated', async () => {
		const { tools, actions } = personal({ kind: 'session', ref: 'personal:cutgrid/wrk1' });
		const result = await executeTool(
			'activate',
			{ name: 'the cloud session' },
			{ ...tools, utterance: 'Can you activate the cloud session?' },
		);

		expect(actions).toEqual([]);
		expect(result).toEqual({
			ok: false,
			content:
				'No worktree called "the cloud session". Say so in a few words; list_sessions lists what there is.',
		});
	});

	it("in Personal, naming the other machine's session outright → activated", async () => {
		const { tools, actions } = personal({ kind: 'session', ref: 'personal:cutgrid/wrk1' });

		await executeTool(
			'activate',
			{ name: 'crew main' },
			{
				...tools,
				utterance: 'start crew main',
				getState: () => ({ ...tools.getState(), active: [] }),
			},
		);

		expect(actions[0]).toEqual({ type: 'activate', ref: 'crew/main', announce: true });
	});
});

describe('a session named with its machine', () => {
	const both = () => {
		const refs = ['crew/main', 'personal:crew/main', 'personal:cutgrid/wrk1'];

		return createContext({
			sessions: Object.fromEntries(
				refs.map((ref) => [
					ref,
					createSession({
						ref,
						label: ref.replace(/^personal:/, ''),
						branch: '',
						cwd: '/w',
						dirs: [],
						isPinned: false,
					}),
				]),
			),
			order: refs,
			view: { kind: 'session', ref: 'personal:cutgrid/wrk1' },
			machines: {
				personal: {
					id: 'personal',
					host: 'personal',
					name: 'Personal',
					status: 'connected',
					detail: null,
					since: 0,
				},
			},
		});
	};

	it('"go to crew main on my Mac" from inside Personal → this Mac\'s crew main, from the words', async () => {
		const { tools, actions } = both();

		await executeTool(
			'switch_view',
			{ ref: 'crew main' },
			{ ...tools, utterance: 'Go to crew main session on my Mac.' },
		);

		expect(actions).toEqual([{ type: 'switch_view', view: { kind: 'session', ref: 'crew/main' } }]);
	});

	it("the machine passed with the ref → that machine's session", async () => {
		const { tools, actions } = both();

		await executeTool('switch_view', { ref: 'crew/main', machine: 'this Mac' }, tools);
		await executeTool('switch_view', { ref: 'crew/main', machine: 'Personal' }, tools);

		expect(actions.map((action) => action.type === 'switch_view' && action.view)).toEqual([
			{ kind: 'session', ref: 'crew/main' },
			{ kind: 'session', ref: 'personal:crew/main' },
		]);
	});

	it("no machine said, inside Personal → Personal's crew main, as before", async () => {
		const { tools, actions } = both();

		await executeTool(
			'switch_view',
			{ ref: 'crew main' },
			{ ...tools, utterance: 'go to crew main' },
		);

		expect(actions).toEqual([
			{ type: 'switch_view', view: { kind: 'session', ref: 'personal:crew/main' } },
		]);
	});

	it('"start crew main on my Mac" from inside Personal → this Mac\'s crew main activated, not refused', async () => {
		const { tools, actions } = both();
		const inactive = { ...tools.getState(), active: [] };

		await executeTool(
			'activate',
			{ name: 'crew main' },
			{ ...tools, getState: () => inactive, utterance: 'start crew main on my Mac' },
		);

		expect(actions).toEqual([{ type: 'activate', ref: 'crew/main', announce: true }]);
	});

	it('"into my Mac" and "into Personal" → that machine, as "on" does', () => {
		const { state } = both();

		expect(findMachineSaid(state, 'go into crew main into my Mac')).toBe('local');
		expect(findMachineSaid(state, 'switch into crew main into Personal')).toBe('personal');
	});

	it('"go into crew main" alone → no machine said', () => {
		const { state } = both();

		expect(findMachineSaid(state, 'go into crew main')).toBeNull();
	});
});

describe('what the kernel is offered', () => {
	it('this Mac alone → the tools as before machines: no machine tool, the plain switch_view', () => {
		const plain = listToolsFor(null, false);

		expect(plain.some((tool) => tool.name === 'rename_machine')).toBe(false);
		expect(
			Object.keys(plain.find((tool) => tool.name === 'switch_view')?.input_schema.properties ?? {}),
		).toEqual(['ref', 'active', 'skip_held']);
	});

	it('with other machines → rename_machine, and switch_view takes a machine', () => {
		const withMachines = listToolsFor(null, true);

		expect(withMachines.some((tool) => tool.name === 'rename_machine')).toBe(true);
		expect(
			withMachines.find((tool) => tool.name === 'switch_view')?.input_schema.properties,
		).toHaveProperty('machine');
		expect(withMachines.filter((tool) => tool.name === 'switch_view')).toHaveLength(1);
	});
});
