import { englishJudge } from '../../test/support/english-judge.js';
import { describe, expect, it } from 'bun:test';
import type { Action, Machine, State } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { createNullNotes } from '../../test/support/notes.js';
import { executeTool, type ToolContext } from './tools.js';
import { describeToolCall } from './call-lines.js';
import { MACHINE_TOOL_DEFINITIONS, TOOL_DEFINITIONS, type ToolDefinition } from './definitions.js';

const buildMachine = (patch: Partial<Machine> = {}): Machine => ({
	id: 'vm1',
	host: 'dev@vm1',
	name: 'Build box',
	status: 'connected',
	detail: null,
	since: 0,
	...patch,
});

interface CreateContextParams {
	patch?: Partial<State>;
	screen?: string | null;
	utterance?: string;
}

const createContext = ({ patch = {}, screen = null, utterance }: CreateContextParams = {}) => {
	const refs = ['crew/main', 'store-front/wrk1', 'vm1:store-front/main', 'setup'];
	const state: State = {
		...createInitialState(),
		sessions: Object.fromEntries(
			refs.map((ref) => [
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
		order: refs,
		machines: { vm1: buildMachine() },
		...patch,
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
		screen,
		utterance,
	};

	return { tools, actions };
};

const findSwitchView = (definitions: ToolDefinition[]) =>
	definitions.find((definition) => definition.name === 'switch_view');

describe('pin_session', () => {
	it('"pin this" on a session → that session pinned, with a fixed reply', async () => {
		const { tools, actions } = createContext({ screen: 'crew/main' });

		const result = await executeTool('pin_session', { ref: null }, tools);

		expect(actions).toEqual([{ type: 'pin_session', ref: 'crew/main' }]);
		expect(result).toMatchObject({ ok: true, reply: 'Pinned crew, main.' });
		expect(result.recordAs).toEqual({ name: 'pin_session', input: { ref: 'crew/main' } });
	});

	it('by a spoken name → the ref it resolves to', async () => {
		const { tools, actions } = createContext();

		const result = await executeTool('pin_session', { ref: 'store front work one' }, tools);

		expect(actions).toEqual([{ type: 'pin_session', ref: 'store-front/wrk1' }]);
		expect(result.reply).toBe('Pinned store front, work 1.');
	});

	it('the setup session by name → pinned', async () => {
		const { tools, actions } = createContext();

		await executeTool('pin_session', { ref: 'setup session' }, tools);

		expect(actions).toEqual([{ type: 'pin_session', ref: 'setup' }]);
	});

	it("another machine's session named with its machine → pinned, its machine in the reply", async () => {
		const { tools, actions } = createContext({ utterance: 'pin store front main on build box' });

		const result = await executeTool('pin_session', { ref: 'store-front/main' }, tools);

		expect(actions).toEqual([{ type: 'pin_session', ref: 'vm1:store-front/main' }]);
		expect(result.reply).toBe('Pinned Build box store front, main.');
	});

	it('"unpin this" on a session opened from Pinned → unpinned', async () => {
		const { tools, actions } = createContext({
			screen: 'crew/main',
			patch: { pinned: ['crew/main'], view: { kind: 'session', ref: 'crew/main', from: 'pinned' } },
		});

		const result = await executeTool('pin_session', { ref: null, unpin: true }, tools);

		expect(actions).toEqual([{ type: 'unpin_session', ref: 'crew/main' }]);
		expect(result.reply).toBe('Unpinned crew, main.');
	});

	it('an out-of-reach pin whose session is not listed → unpinned by its name', async () => {
		const { tools, actions } = createContext({
			patch: {
				pinned: ['vm2:checkout-api/main'],
				machines: { vm1: buildMachine(), vm2: buildMachine({ id: 'vm2', status: 'unreachable' }) },
			},
		});

		const result = await executeTool(
			'pin_session',
			{ ref: 'checkout api main', unpin: true },
			tools,
		);

		expect(actions).toEqual([{ type: 'unpin_session', ref: 'vm2:checkout-api/main' }]);
		expect(result.ok).toBe(true);
	});

	it('no session on screen and no ref → fails, nothing dispatched', async () => {
		const { tools, actions } = createContext();

		expect(await executeTool('pin_session', { ref: null }, tools)).toEqual({
			ok: false,
			content: 'no session on screen: name one',
		});
		expect(actions).toEqual([]);
	});

	it('an unknown name → fails, nothing dispatched', async () => {
		const { tools, actions } = createContext();

		expect((await executeTool('pin_session', { ref: 'billing main' }, tools)).ok).toBe(false);
		expect(actions).toEqual([]);
	});

	it('pinning a pinned session → the reply, no dispatch', async () => {
		const { tools, actions } = createContext({ patch: { pinned: ['crew/main'] } });

		expect((await executeTool('pin_session', { ref: 'crew/main' }, tools)).reply).toBe(
			'Pinned crew, main.',
		);
		expect(actions).toEqual([]);
	});

	it('unpinning a session that is not pinned → fails "not pinned", no dispatch', async () => {
		const { tools, actions } = createContext({ patch: { pinned: ['crew/main'] } });

		expect(
			await executeTool('pin_session', { ref: 'store-front/wrk1', unpin: true }, tools),
		).toEqual({ ok: false, content: 'store front, work 1 is not pinned' });
		expect(actions).toEqual([]);
	});

	it('unpin by words both a listed session and a gone pin answer to → the pin', async () => {
		const { tools, actions } = createContext({
			patch: {
				pinned: ['vm2:store-front/wrk1'],
				machines: {
					vm1: buildMachine(),
					vm2: buildMachine({ id: 'vm2', name: 'Spare', status: 'unreachable' }),
				},
			},
		});

		const result = await executeTool(
			'pin_session',
			{ ref: 'store front work 1', unpin: true },
			tools,
		);

		expect(actions).toEqual([{ type: 'unpin_session', ref: 'vm2:store-front/wrk1' }]);
		expect(result.ok).toBe(true);
	});

	it('describeToolCall → pin and unpin told apart', () => {
		expect(describeToolCall({ name: 'pin_session', input: { ref: 'crew/main' }, ok: true })).toBe(
			'pin_session pin crew/main',
		);
		expect(
			describeToolCall({ name: 'pin_session', input: { ref: 'crew/main', unpin: true }, ok: true }),
		).toBe('pin_session unpin crew/main');
	});
});

describe('switch_view pinned', () => {
	it('pinned true → the Pinned view, over a ref or a machine', async () => {
		const { tools, actions } = createContext();

		await executeTool('switch_view', { ref: 'crew/main', pinned: true }, tools);
		await executeTool('switch_view', { ref: null, machine: 'build box', pinned: true }, tools);

		expect(actions).toEqual([
			{ type: 'switch_view', view: { kind: 'pinned' } },
			{ type: 'switch_view', view: { kind: 'pinned' } },
		]);
	});

	it('describeToolCall → switch_view pinned', () => {
		expect(
			describeToolCall({ name: 'switch_view', input: { ref: null, pinned: true }, ok: true }),
		).toBe('switch_view pinned');
	});

	it('both switch_view definitions → the same pinned property', () => {
		const plain = findSwitchView(TOOL_DEFINITIONS)?.input_schema.properties.pinned;
		const withMachines = findSwitchView(MACHINE_TOOL_DEFINITIONS)?.input_schema.properties.pinned;

		expect(plain).toBeDefined();
		expect(withMachines).toEqual(plain);
	});
});
