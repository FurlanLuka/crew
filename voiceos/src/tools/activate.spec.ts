import { englishJudge, judgeAlways } from '../../test/support/english-judge.js';
import { createToolContext } from '../../test/support/tool-context.js';
import { describe, expect, it } from 'bun:test';
import type { Action, Machine, PendingAsk, State } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { createNullNotes } from '../../test/support/notes.js';
import { executeTool, type ToolContext } from './tools.js';
import { describeToolCall } from './call-lines.js';
import { MACHINE_TOOL_DEFINITIONS, TOOL_DEFINITIONS, type ToolDefinition } from './definitions.js';
import { decideActivate, refuseInactive } from './activate.js';

const buildMachine = (patch: Partial<Machine> = {}): Machine => ({
	id: 'vm1',
	host: 'dev@vm1',
	name: 'Build box',
	status: 'connected',
	detail: null,
	since: 0,
	...patch,
});

const REFS = [
	'setup',
	'crew/main',
	'store-front/main',
	'store-front/wrk1',
	'vm1:setup',
	'vm1:store-front/main',
	'vm1:signals/wrk1',
	'vm1:signals/wrk2',
];

interface CreateContextParams {
	patch?: Partial<State>;
	screen?: string | null;
	utterance?: string;
}

// Nothing active but this Mac's setup unless the test says which are.
const createState = (patch: Partial<State> = {}): State => ({
	...createInitialState(),
	sessions: Object.fromEntries(
		REFS.map((ref) => [
			ref,
			{
				...createSession({
					ref,
					label: ref.replace(/^vm1:/, ''),
					branch: '',
					cwd: '/w',
					dirs: [],
					isPinned: ref.endsWith('setup'),
				}),
				status: 'idle' as const,
			},
		]),
	),
	order: REFS,
	machines: { vm1: buildMachine() },
	active: [],
	...patch,
});

const createContext = ({ patch = {}, screen = null, utterance }: CreateContextParams = {}) => {
	const state = createState({
		...(screen ? { view: { kind: 'session', ref: screen } } : {}),
		...patch,
	});
	const actions: Action[] = [];
	const tools: ToolContext = {
		getState: () => state,
		dispatch: (action) => actions.push(action),
		readHistory: () => [],
		now: () => 1000,
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

	return { state, tools, actions };
};

const findSwitchView = (definitions: ToolDefinition[]) =>
	definitions.find((definition) => definition.name === 'switch_view');

describe('decideActivate', () => {
	it('one worktree answers → that one', () => {
		expect(decideActivate({ state: createState(), name: 'crew main', machine: null })).toEqual({
			kind: 'one',
			ref: 'crew/main',
		});
	});

	it('a workspace said → every worktree in it', () => {
		for (const name of ['signals', 'the signals workspace']) {
			expect(decideActivate({ state: createState(), name, machine: null })).toEqual({
				kind: 'several',
				refs: ['vm1:signals/wrk1', 'vm1:signals/wrk2'],
			});
		}
	});

	it('the same name on two machines, no machine said → several', () => {
		expect(
			decideActivate({ state: createState(), name: 'store front main', machine: null }),
		).toEqual({ kind: 'several', refs: ['store-front/main', 'vm1:store-front/main'] });
	});

	it("a machine said → only that machine's worktrees", () => {
		expect(
			decideActivate({ state: createState(), name: 'store front main', machine: 'vm1' }),
		).toEqual({ kind: 'one', ref: 'vm1:store-front/main' });
		expect(
			decideActivate({ state: createState(), name: 'store front main', machine: 'local' }),
		).toEqual({ kind: 'one', ref: 'store-front/main' });
		expect(decideActivate({ state: createState(), name: 'crew main', machine: 'vm1' })).toEqual({
			kind: 'none',
		});
	});

	it("the developer's own name for a worktree → that one", () => {
		const state = createState({ names: { 'vm1:signals/wrk2': 'ranking' } });

		expect(decideActivate({ state, name: 'ranking', machine: null })).toEqual({
			kind: 'one',
			ref: 'vm1:signals/wrk2',
		});
	});

	it('nothing answers → none', () => {
		expect(decideActivate({ state: createState(), name: 'billing', machine: null })).toEqual({
			kind: 'none',
		});
	});

	it("already active → already; this Mac's setup always is", () => {
		const state = createState({ active: ['crew/main'] });

		expect(decideActivate({ state, name: 'crew main', machine: null })).toEqual({
			kind: 'already',
			ref: 'crew/main',
		});
		expect(decideActivate({ state, name: 'setup', machine: null })).toEqual({
			kind: 'already',
			ref: 'setup',
		});
	});

	it("a remote's setup session, its machine said → that one, not this Mac's", () => {
		expect(decideActivate({ state: createState(), name: 'setup', machine: 'vm1' })).toEqual({
			kind: 'one',
			ref: 'vm1:setup',
		});
	});
});

describe('activate', () => {
	it('by voice → activated with the announcement; Voice OS offers the switch itself', async () => {
		const { tools, actions } = createContext({ utterance: 'activate crew main' });

		const result = await executeTool('activate', { name: 'crew main' }, tools);

		expect(actions).toEqual([{ type: 'activate', ref: 'crew/main', announce: true }]);
		expect(result).toEqual({
			ok: true,
			content: 'activated crew/main; Voice OS said so: say nothing',
			recordAs: { name: 'activate', input: { name: 'crew/main' } },
		});
	});

	it('"activate this" on a session → the one on screen', async () => {
		const { tools, actions } = createContext({ screen: 'store-front/wrk1' });

		const result = await executeTool('activate', { name: null }, tools);

		expect(actions).toEqual([{ type: 'activate', ref: 'store-front/wrk1', announce: true }]);
		// On its own screen Voice OS says nothing, and the result does not claim it did.
		expect(result.content).toBe('activated store-front/wrk1: say nothing');
	});

	it('"activate this" on Mission Control → fails, nothing dispatched', async () => {
		const { tools, actions } = createContext();

		expect(await executeTool('activate', { name: null }, tools)).toEqual({
			ok: false,
			content: 'no session on screen: ask which worktree to activate',
		});
		expect(actions).toEqual([]);
	});

	it("the machine named in the words → that machine's worktree", async () => {
		const { tools, actions } = createContext({
			utterance: 'activate store front main on build box',
		});

		await executeTool('activate', { name: 'store front main' }, tools);

		expect(actions).toEqual([{ type: 'activate', ref: 'vm1:store-front/main', announce: true }]);
	});

	it('a yes to "Activate it?" → activated and announced; words kept in its queue go on its start', async () => {
		const { tools, actions } = createContext({
			screen: 'crew/main',
			patch: {
				active: ['crew/main'],
				switchOffer: { ref: 'store-front/wrk1', at: 900, kind: 'activate' },
			},
		});

		const result = await executeTool('activate', { name: 'store-front/wrk1' }, tools);

		expect(actions).toEqual([{ type: 'activate', ref: 'store-front/wrk1', announce: true }]);
		expect(result).toEqual({
			ok: true,
			content: 'activated store-front/wrk1; Voice OS said so: say nothing',
			recordAs: { name: 'activate', input: { name: 'store-front/wrk1' } },
		});
	});

	it('a yes to "Activate it?" asked for a switch → activated and shown', async () => {
		const { tools, actions } = createContext({
			patch: { switchOffer: { ref: 'crew/main', at: 900, kind: 'activate', thenSwitch: true } },
		});

		const result = await executeTool('activate', { name: 'crew/main' }, tools);

		expect(actions).toEqual([
			{ type: 'activate', ref: 'crew/main' },
			{ type: 'switch_view', view: { kind: 'session', ref: 'crew/main' }, announce: true },
		]);
		expect(result.content).toBe(
			'activated crew/main and switched there; Voice OS said so: say nothing',
		);
	});

	it('already active → said so, nothing dispatched', async () => {
		const { tools, actions } = createContext({ patch: { active: ['crew/main'] } });

		expect(await executeTool('activate', { name: 'crew main' }, tools)).toEqual({
			ok: true,
			content: 'crew/main is already active',
			recordAs: { name: 'activate', input: { name: 'crew/main' } },
			reply: 'crew, main is already active.',
		});
		expect(actions).toEqual([]);
	});

	it('several answer → nothing activated, the kernel asks which by machine and name', async () => {
		const { tools, actions } = createContext();

		const result = await executeTool('activate', { name: 'signals' }, tools);

		expect(actions).toEqual([]);
		expect(result.ok).toBe(false);
		expect(result.content).toBe(
			'Several worktrees answer to "signals": vm1:signals/wrk1, vm1:signals/wrk2. Nothing was activated. Ask which in a few words: "Build box has signals, work 1 and signals, work 2. Which?"',
		);
	});

	it('the same name on two machines → asks which, each with its machine', async () => {
		const { tools } = createContext({ utterance: 'activate store front main' });

		const result = await executeTool('activate', { name: 'store front main' }, tools);

		expect(result.content).toBe(
			'Several worktrees answer to "store front main": store-front/main, vm1:store-front/main. Nothing was activated. Ask which in a few words: "store front, main on This Mac and store front, main on Build box. Which?"',
		);
	});

	it('nothing answers → fails naming the machine asked about, nothing dispatched', async () => {
		const { tools, actions } = createContext();

		expect(await executeTool('activate', { name: 'billing', machine: 'build box' }, tools)).toEqual(
			{
				ok: false,
				content:
					'No worktree called "billing" on Build box. Say so in a few words; list_sessions lists what there is.',
			},
		);
		expect(actions).toEqual([]);
	});

	it('"start checkout and run the tests" → activated, and the rest is sent once it is up', async () => {
		const { tools, actions } = createContext({ utterance: 'start crew main and run the tests' });

		const result = await executeTool('activate', { name: 'crew main' }, tools);

		expect(actions).toEqual([{ type: 'activate', ref: 'crew/main', announce: true }]);
		expect(result.content).toBe(
			'activated crew/main. The developer also asked it something: send_to crew/main that part now — it waits until the session is up.',
		);
	});

	it('the judge hears only a start → no hint', async () => {
		const { tools } = createContext({ utterance: 'Starte crew main.' });

		const result = await executeTool(
			'activate',
			{ name: 'crew main' },
			{ ...tools, judge: judgeAlways('no') },
		);

		expect(result.content).toBe('activated crew/main; Voice OS said so: say nothing');
	});

	it('describeToolCall → the worktree as resolved', () => {
		expect(describeToolCall({ name: 'activate', input: { name: 'crew/main' }, ok: true })).toBe(
			'activate crew/main',
		);
	});
});

describe('deactivate', () => {
	it('null → the session on screen, with a fixed reply', async () => {
		const { tools, actions } = createContext({
			screen: 'crew/main',
			patch: { active: ['crew/main'] },
		});

		const result = await executeTool('deactivate', { ref: null }, tools);

		expect(actions).toEqual([{ type: 'deactivate', ref: 'crew/main' }]);
		expect(result).toEqual({
			ok: true,
			content: 'deactivated crew/main',
			reply: 'Deactivated crew, main.',
			recordAs: { name: 'deactivate', input: { ref: 'crew/main' } },
		});
	});

	it('null on Mission Control → fails, nothing dispatched', async () => {
		const { tools, actions } = createContext();

		expect(await executeTool('deactivate', { ref: null }, tools)).toEqual({
			ok: false,
			content: 'no session on screen: name one',
		});
		expect(actions).toEqual([]);
	});

	it('a working session → Voice OS asks "Deactivate anyway?", nothing deactivated', async () => {
		const { state, tools, actions } = createContext({
			screen: 'crew/main',
			patch: { active: ['crew/main'] },
		});
		state.sessions['crew/main'] = { ...state.sessions['crew/main']!, status: 'running' };

		const result = await executeTool('deactivate', { ref: null }, tools);

		expect(actions).toEqual([{ type: 'offer_switch', ref: 'crew/main', kind: 'deactivate' }]);
		expect(result).toEqual({
			ok: false,
			content:
				'Not deactivated yet: crew/main is working, and Voice OS asked "crew, main is working. Deactivate anyway?" itself: say nothing.',
			isFinal: true,
			note: 'activate offered',
		});
	});

	it('a yes to "Deactivate anyway?" → deactivated, though it is working and the yes names nothing', async () => {
		const { state, tools, actions } = createContext({
			utterance: 'yes',
			patch: {
				active: ['crew/main', 'store-front/main'],
				switchOffer: { ref: 'crew/main', at: 900, kind: 'deactivate' },
			},
		});
		state.sessions['crew/main'] = { ...state.sessions['crew/main']!, status: 'blocked' };

		await executeTool('deactivate', { ref: 'crew/main' }, tools);

		expect(actions).toEqual([{ type: 'deactivate', ref: 'crew/main' }]);
	});

	it('the setup session → refused, it is always active', async () => {
		const { tools, actions } = createContext({ screen: 'setup' });

		expect(await executeTool('deactivate', { ref: null }, tools)).toEqual({
			ok: false,
			content: 'the setup session is always active',
			reply: 'Setup is always active.',
		});
		expect(actions).toEqual([]);
	});

	it('a session that is not active → said so, nothing dispatched', async () => {
		const { tools, actions } = createContext({ utterance: 'deactivate work one' });

		expect(await executeTool('deactivate', { ref: 'store-front/wrk1' }, tools)).toEqual({
			ok: true,
			content: 'store-front/wrk1 is not active',
			reply: "store front, work 1 isn't active.",
		});
		expect(actions).toEqual([]);
	});

	it('words that do not name exactly one session → refused, ask which', async () => {
		const { tools, actions } = createContext({
			utterance: 'End the main session.',
			patch: { active: ['crew/main', 'store-front/main'] },
		});

		const result = await executeTool('deactivate', { ref: 'crew/main' }, tools);

		expect(result.ok).toBe(false);
		expect(result.content).toContain('did not name exactly one session');
		expect(result.content).toContain('Ask which one.');
		expect(actions).toEqual([]);
	});
});

describe('activate on an unknown machine', () => {
	it('a machine named that is not known → said so, nothing activated, never every machine searched', async () => {
		const { tools, actions } = createContext();

		const result = await executeTool(
			'activate',
			{ name: 'store front main', machine: 'Nowhere' },
			tools,
		);

		expect(result.ok).toBe(false);
		expect(result.content).toStartWith('No machine called Nowhere.');
		expect(actions).toEqual([]);
	});
});

describe('refuseInactive', () => {
	it('words for it → queued for it (its queue keeps them), then "Activate it?"; the turn ends', () => {
		const { tools, actions } = createContext();

		const result = refuseInactive({ ref: 'crew/main', toolContext: tools, words: 'run the tests' });

		expect(actions).toEqual([
			{ type: 'send', ref: 'crew/main', text: 'run the tests', isSpoken: true },
			{ type: 'offer_switch', ref: 'crew/main', kind: 'activate' },
		]);
		expect(result).toEqual({
			ok: false,
			content:
				'Nothing was done: crew/main is not active. Voice OS asked "… isn\'t active. Activate it?" itself; the words wait for it: say nothing.',
			isFinal: true,
			note: 'activate offered',
		});
	});

	it('a switch → a yes goes there too; no words, none kept', () => {
		const { tools, actions } = createContext();

		const result = refuseInactive({ ref: 'crew/main', toolContext: tools, isSwitch: true });

		expect(actions).toEqual([
			{ type: 'offer_switch', ref: 'crew/main', kind: 'activate', thenSwitch: true },
		]);
		expect(result.content).toBe(
			'Nothing was done: crew/main is not active. Voice OS asked "… isn\'t active. Activate it?" itself: say nothing.',
		);
	});
});

describe('words, a switch or a command for an inactive session', () => {
	// checkout-api/main is the one not active.
	const inactiveCheckout = () =>
		createToolContext({ active: ['store-front/main', 'store-front/wrk1'] });

	it('send_to → the words queued for it, "Activate it?"; nothing reaches it', async () => {
		const { tools, actions } = inactiveCheckout();

		const result = await executeTool(
			'send_to',
			{ ref: 'checkout-api/main', text: 'Run the tests.' },
			{ ...tools, utterance: 'checkout api main, run the tests' },
		);

		// The words as said, as send_to sends them to an active session.
		expect(actions).toEqual([
			{
				type: 'send',
				ref: 'checkout-api/main',
				text: 'checkout api main, run the tests',
				isSpoken: true,
			},
			{ type: 'offer_switch', ref: 'checkout-api/main', kind: 'activate' },
		]);
		expect(result).toMatchObject({ ok: false, isFinal: true });
	});

	it('forward on its screen → the words queued for it, "Activate it?"', async () => {
		const { tools, actions } = inactiveCheckout();

		const result = await executeTool(
			'forward',
			{ text: 'Run the tests.', kind: 'instruction' },
			{ ...tools, forwardTo: 'checkout-api/main', screen: 'checkout-api/main' },
		);

		expect(actions).toEqual([
			{ type: 'send', ref: 'checkout-api/main', text: 'Run the tests.', isSpoken: true },
			{ type: 'offer_switch', ref: 'checkout-api/main', kind: 'activate' },
		]);
		expect(result).toMatchObject({ ok: false, isFinal: true });
	});

	it('switch_view → "Activate it?", a yes goes there; nothing shown', async () => {
		const { tools, actions } = inactiveCheckout();

		const result = await executeTool('switch_view', { ref: 'checkout-api/main' }, tools);

		expect(actions).toEqual([
			{ type: 'offer_switch', ref: 'checkout-api/main', kind: 'activate', thenSwitch: true },
		]);
		expect(result).toMatchObject({ ok: false, isFinal: true });
	});

	it('crew_dev → "Activate it?", the servers untouched', async () => {
		const { tools, actions } = inactiveCheckout();

		const result = await executeTool(
			'crew_dev',
			{ ref: 'checkout-api/main', action: 'restart' },
			tools,
		);

		expect(actions).toEqual([{ type: 'offer_switch', ref: 'checkout-api/main', kind: 'activate' }]);
		expect(result).toMatchObject({ ok: false, isFinal: true });
	});

	it('answer → the words said queued for it, "Activate it?"; nothing answered', async () => {
		const ask: PendingAsk = {
			id: 'p1',
			ref: 'checkout-api/main',
			at: 1,
			kind: 'permission',
			toolName: 'Bash',
			summary: 'run git push',
			input: {},
			suggestions: [],
		};
		const { tools, actions } = createToolContext({
			active: ['store-front/main', 'store-front/wrk1'],
			asks: [ask],
		});

		const result = await executeTool(
			'answer',
			{ ref: 'checkout-api/main', decision: 'yes' },
			{ ...tools, asks: [ask], utterance: 'yes, push it' },
		);

		expect(actions).toEqual([
			{ type: 'send', ref: 'checkout-api/main', text: 'yes, push it', isSpoken: true },
			{ type: 'offer_switch', ref: 'checkout-api/main', kind: 'activate' },
		]);
		expect(result).toMatchObject({ ok: false, isFinal: true });
	});
});

describe('switch_view active', () => {
	it('active true → the Active view, over a ref or a machine', async () => {
		const { tools, actions } = createContext();

		await executeTool('switch_view', { ref: 'crew/main', active: true }, tools);
		await executeTool('switch_view', { ref: null, machine: 'build box', active: true }, tools);

		expect(actions).toEqual([
			{ type: 'switch_view', view: { kind: 'active' } },
			{ type: 'switch_view', view: { kind: 'active' } },
		]);
	});

	it('describeToolCall → switch_view active', () => {
		expect(
			describeToolCall({ name: 'switch_view', input: { ref: null, active: true }, ok: true }),
		).toBe('switch_view active');
	});

	it('both switch_view definitions → the same active property', () => {
		const plain = findSwitchView(TOOL_DEFINITIONS)?.input_schema.properties.active;
		const withMachines = findSwitchView(MACHINE_TOOL_DEFINITIONS)?.input_schema.properties.active;

		expect(plain).toBeDefined();
		expect(withMachines).toEqual(plain);
	});
});
