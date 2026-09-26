import { describe, expect, it } from 'bun:test';
import type { Action, PendingAsk, State } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { Store } from '../state/store.js';
import { executeTool, type ToolContext } from './tools.js';
import { describeToolCall, isSilentCall } from './call-lines.js';
import { TOOL_DEFINITIONS, listToolsFor, MUTATING_TOOLS } from './definitions.js';
import { findSessionsNamedIn, isSessionNamed } from './session-naming.js';
import { describeSession } from './session-view.js';

const createToolContext = (patch: Partial<State> = {}) => {
	const refs = ['store-front/main', 'store-front/wrk1', 'checkout-api/main'];
	const sessions: State['sessions'] = Object.fromEntries(
		refs.map((ref) => [
			ref,
			{
				...createSession({ ref, label: ref, branch: '', cwd: '/w', dirs: [], isPinned: false }),
				status: 'idle' as const,
			},
		]),
	);
	sessions['checkout-api/main'] = {
		...sessions['checkout-api/main']!,
		status: 'stopped',
		topic: 'Checkout retry backoff',
	};
	const state: State = {
		...createInitialState(),
		sessions,
		order: refs,
		focus: 'store-front/main',
		...patch,
	};
	const actions: Action[] = [];
	const tools: ToolContext = {
		getState: () => state,
		dispatch: (action) => actions.push(action),
		readHistory: ({ ref, query, limit }) => [
			{ ts: '2026-09-24', ref: ref ?? 'store-front/main', asked: query, did: `limit ${limit}` },
		],
		now: () => 0,
		asks: state.asks,
		mute: () => {},
		saveDebugNote: () => {},
	};

	return { tools, actions };
};

describe('tool definitions', () => {
	it('every tool has an object schema that forbids extra keys', () => {
		for (const definition of TOOL_DEFINITIONS) {
			expect(definition.input_schema).toMatchObject({
				type: 'object',
				additionalProperties: false,
			});
		}
	});
});

describe('executeTool', () => {
	it('send_to → dispatches send with trimmed text', async () => {
		const { tools, actions } = createToolContext();

		expect(
			await executeTool('send_to', { ref: 'store-front/wrk1', text: '  run the tests ' }, tools),
		).toEqual({ ok: true, content: 'sent to store-front/wrk1' });
		expect(actions).toEqual([{ type: 'send', ref: 'store-front/wrk1', text: 'run the tests' }]);
	});

	it('unknown ref → error listing real sessions, nothing dispatched', async () => {
		const { tools, actions } = createToolContext();

		const result = await executeTool('send_to', { ref: 'billing/main', text: 'x' }, tools);

		expect(result.ok).toBe(false);
		expect(result.content).toContain('store-front/main');
		expect(actions).toEqual([]);
	});

	it('near-miss ref ("work one") → resolved like resolveRef', async () => {
		const { tools, actions } = createToolContext();

		await executeTool('switch_view', { ref: 'work one' }, tools);

		expect(actions).toEqual([
			{ type: 'switch_view', view: { kind: 'session', ref: 'store-front/wrk1' } },
		]);
	});

	it('switch_view null → Mission Control', async () => {
		const { tools, actions } = createToolContext();

		await executeTool('switch_view', { ref: null }, tools);

		expect(actions).toEqual([{ type: 'switch_view', view: { kind: 'grid' } }]);
	});

	it('start_session on a running session → no dispatch, says so', async () => {
		const { tools, actions } = createToolContext();

		expect((await executeTool('start_session', { ref: 'store-front/main' }, tools)).content).toBe(
			'store-front/main is already idle',
		);
		expect(actions).toEqual([]);
	});

	it('start_session on a stopped one → started and shown', async () => {
		const { tools, actions } = createToolContext();

		await executeTool('start_session', { ref: 'checkout-api/main' }, tools);

		expect(actions).toEqual([
			{ type: 'start_session', ref: 'checkout-api/main' },
			{ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } },
		]);
	});

	it('crew_dev start/stop/restart → the same action a panel button dispatches; anything else refused', async () => {
		const { tools, actions } = createToolContext();

		for (const action of ['start', 'stop', 'restart'] as const) {
			expect((await executeTool('crew_dev', { ref: 'store-front/main', action }, tools)).ok).toBe(
				true,
			);
		}

		expect(
			(await executeTool('crew_dev', { ref: 'store-front/main', action: 'delete' }, tools)).ok,
		).toBe(false);
		expect(actions).toEqual([
			{ type: 'dev_start', ref: 'store-front/main' },
			{ type: 'dev_stop', ref: 'store-front/main' },
			{ type: 'dev_restart', ref: 'store-front/main' },
		]);
	});

	it('crew_dev status → what Voice OS already knows about the servers, nothing dispatched', async () => {
		const { tools, actions } = createToolContext({
			devServers: {
				'store-front/main': [{ name: 'web', port: 3000, url: null, state: 'died', detail: null }],
			},
		});

		const result = await executeTool(
			'crew_dev',
			{ ref: 'store-front/main', action: 'status' },
			tools,
		);

		expect(JSON.parse(result.content)).toMatchObject({
			servers: [{ name: 'web', state: 'died' }],
			starting: false,
		});
		expect(actions).toEqual([]);
	});

	it('read_state for all → compact rows; for one → with recent turns', async () => {
		const { tools } = createToolContext();
		const all = JSON.parse((await executeTool('read_state', { ref: null }, tools)).content);

		expect(all).toHaveLength(3);
		expect(all[2]).toMatchObject({
			ref: 'checkout-api/main',
			status: 'stopped',
			topic: 'Checkout retry backoff',
		});

		const one = JSON.parse(
			(await executeTool('read_state', { ref: 'store-front/main' }, tools)).content,
		);

		expect(one).toHaveProperty('recent');
	});

	it('read_history → limit clamped to 1..20, blank query treated as none', async () => {
		const { tools } = createToolContext();
		const result = JSON.parse(
			(await executeTool('read_history', { ref: null, query: '  ', limit: 500 }, tools)).content,
		);

		expect(result[0]).toMatchObject({ asked: null, did: 'limit 20' });
	});

	it('unknown tool → error', async () => {
		const result = await executeTool('rm_rf', {}, createToolContext().tools);

		expect(result.ok).toBe(false);
	});
});

describe('findSessionsNamedIn', () => {
	const findNamed = (utterance: string) => {
		const { tools } = createToolContext();

		return findSessionsNamedIn(tools.getState(), utterance);
	};

	it('"main" alone names nothing when two workspaces have one', () => {
		expect(findNamed('End the main session.')).toEqual([]);
	});

	it('workspace name → that session', () => {
		expect(findNamed('stop the checkout session')).toEqual(['checkout-api/main']);
	});

	it('spoken worktree name → that session', () => {
		expect(findNamed('stop work one')).toEqual(['store-front/wrk1']);
		expect(findNamed('stop wrk1')).toEqual(['store-front/wrk1']);
	});

	it('two topic words → that session', () => {
		expect(findNamed('stop the retry backoff one')).toEqual(['checkout-api/main']);
	});

	it('full ref → that session', () => {
		expect(findNamed('end store-front/main')).toEqual(['store-front/main']);
	});
});

describe('isSessionNamed', () => {
	const isNamed = (
		ref: string,
		utterance: string,
		order: string[],
		topic: string | null = null,
	) => {
		const text = ` ${utterance} `;

		return isSessionNamed({ ref, topic, text, words: new Set(utterance.split(' ')), order });
	};

	it('workspace word, lone worktree → named', () => {
		expect(isNamed('checkout-api/main', 'stop checkout', ['checkout-api/main'])).toBe(true);
	});

	it('workspace word, several worktrees → needs the spoken worktree', () => {
		const order = ['store-front/main', 'store-front/wrk2'];

		expect(isNamed('store-front/wrk2', 'stop store', order)).toBe(false);
		expect(isNamed('store-front/wrk2', 'stop store work two', order)).toBe(true);
	});

	it('non-main worktree alone → named; main alone → not', () => {
		expect(isNamed('store-front/wrk1', 'stop work 1', ['store-front/wrk1'])).toBe(true);
		expect(
			isNamed('store-front/main', 'stop main', ['store-front/main', 'checkout-api/main']),
		).toBe(false);
	});

	it('two topic words → named; one → not', () => {
		expect(
			isNamed(
				'admin/main',
				'stop the ranking search',
				['admin/main', 'store-front/main'],
				'Search ranking',
			),
		).toBe(true);
		expect(
			isNamed(
				'admin/main',
				'stop the ranking',
				['admin/main', 'store-front/main'],
				'Search ranking',
			),
		).toBe(false);
	});
});

describe('stop_session guard', () => {
	it('ambiguous utterance → refused, nothing dispatched', async () => {
		const { tools, actions } = createToolContext();

		const result = await executeTool(
			'stop_session',
			{ ref: 'store-front/main' },
			{ ...tools, utterance: 'End the main session.' },
		);

		expect(result.ok).toBe(false);
		expect(result.content).toContain('Ask which one');
		expect(actions).toEqual([]);
	});

	it('named session → stopped', async () => {
		const { tools, actions } = createToolContext();

		await executeTool(
			'stop_session',
			{ ref: 'store-front/wrk1' },
			{ ...tools, utterance: 'stop work one' },
		);

		expect(actions).toEqual([{ type: 'stop_session', ref: 'store-front/wrk1' }]);
	});

	it('follow-up answer naming the session → stopped', async () => {
		const { tools, actions } = createToolContext();

		await executeTool(
			'stop_session',
			{ ref: 'checkout-api/main' },
			{ ...tools, recentUtterances: ['End the main session.'], utterance: 'the checkout one' },
		);

		expect(actions).toEqual([{ type: 'stop_session', ref: 'checkout-api/main' }]);
	});

	it('clear command after one about another session → stopped, the earlier one ignored', async () => {
		const { tools, actions } = createToolContext();

		await executeTool(
			'stop_session',
			{ ref: 'store-front/wrk1' },
			{ ...tools, recentUtterances: ['stop the checkout session'], utterance: 'stop work one' },
		);

		expect(actions).toEqual([{ type: 'stop_session', ref: 'store-front/wrk1' }]);
	});
});

describe('forward', () => {
	it('offered only when routing captured a session to forward to', () => {
		expect(listToolsFor(null).some((tool) => tool.name === 'forward')).toBe(false);
		expect(listToolsFor('store-front/main')[0]?.name).toBe('forward');
	});

	it('sends to the session captured at routing, even if the view changed since', async () => {
		const { tools, actions } = createToolContext({
			view: { kind: 'session', ref: 'checkout-api/main' },
		});

		const result = await executeTool(
			'forward',
			{ text: ' why is this so slow ' },
			{ ...tools, forwardTo: 'store-front/wrk1' },
		);

		expect(result.ok).toBe(true);
		expect(actions).toEqual([
			{ type: 'send', ref: 'store-front/wrk1', text: 'why is this so slow' },
		]);
	});

	it('nothing captured, a session that no longer exists, or empty text → refused, nothing sent', async () => {
		const { tools, actions } = createToolContext();

		expect((await executeTool('forward', { text: 'hi' }, tools)).ok).toBe(false);
		expect(
			(await executeTool('forward', { text: 'hi' }, { ...tools, forwardTo: 'gone/main' })).ok,
		).toBe(false);
		expect(
			(await executeTool('forward', { text: '  ' }, { ...tools, forwardTo: 'store-front/main' }))
				.ok,
		).toBe(false);
		expect(actions).toEqual([]);
	});
});

describe('describeSession', () => {
	const createServer = (
		name: string,
		state: 'running' | 'died' | 'not listening' | 'starting',
		detail: string | null = null,
	) => ({ name, port: 3000, url: null, state, detail });

	it('dev servers appear only when some are not running, with what went wrong', () => {
		const { tools } = createToolContext({
			devServers: {
				'store-front/main': [createServer('web', 'running'), createServer('api', 'died', 'exit 1')],
				'store-front/wrk1': [createServer('web', 'running')],
			},
		});
		const state = tools.getState();

		expect(
			describeSession({ state, ref: 'store-front/main', isDetailed: false, now: 0 }),
		).toMatchObject({ dev_servers: [{ name: 'api', state: 'died', detail: 'exit 1' }] });
		expect(
			describeSession({ state, ref: 'store-front/wrk1', isDetailed: false, now: 0 }),
		).not.toHaveProperty('dev_servers');
	});

	it('a fix offer is shown on its session only; once stale it is marked lapsed, so a late yes can be told so', () => {
		const { tools } = createToolContext({
			devOffer: { ref: 'store-front/main', servers: ['api'], at: 1000 },
		});
		const state = tools.getState();

		expect(
			describeSession({ state, ref: 'store-front/main', isDetailed: false, now: 2000 }),
		).toMatchObject({ fix_offer: { servers: ['api'], ago: '1s' } });
		expect(
			describeSession({ state, ref: 'store-front/wrk1', isDetailed: false, now: 2000 }),
		).not.toHaveProperty('fix_offer');
		expect(
			describeSession({ state, ref: 'store-front/main', isDetailed: false, now: 2000 }).fix_offer,
		).not.toHaveProperty('lapsed');
		expect(
			describeSession({
				state,
				ref: 'store-front/main',
				isDetailed: false,
				now: 1000 + 3 * 60_000,
			}),
		).toMatchObject({ fix_offer: { ago: '3m', lapsed: true } });
	});
});

describe('describeToolCall', () => {
	it('one line per change, with its target', () => {
		expect(
			describeToolCall({
				name: 'crew_dev',
				input: { ref: 'store-front/main', action: 'restart' },
				ok: true,
			}),
		).toBe('crew_dev restart store-front/main');
		expect(describeToolCall({ name: 'switch_view', input: { ref: null }, ok: true })).toBe(
			'switch_view mission control',
		);
		expect(
			describeToolCall({ name: 'start_session', input: { ref: 'store-front/main' }, ok: false }),
		).toBe('start_session store-front/main (failed)');
	});

	it('long text is cut and quoted', () => {
		const line = describeToolCall({ name: 'forward', input: { text: 'x'.repeat(200) }, ok: true });

		expect(line).toBe(`forward "${'x'.repeat(120)}…"`);
	});

	it('reads are not changes', () => {
		expect(describeToolCall({ name: 'read_state', input: { ref: null }, ok: true })).toBeNull();
		expect(describeToolCall({ name: 'read_history', input: {}, ok: true })).toBeNull();
	});
});

describe('Voice OS note on a first message', () => {
	const diedServers = {
		'checkout-api/main': [
			{ name: 'api', port: 3000, url: null, state: 'died' as const, detail: 'exit 1' },
		],
	};

	it('send_to a stopped session → the note rides along, the words stay as written', async () => {
		const { tools, actions } = createToolContext({ devServers: diedServers });

		await executeTool(
			'send_to',
			{ ref: 'checkout-api/main', text: 'Check the dev server logs.' },
			{ ...tools, recentUtterances: ['Why were they failing?'] },
		);

		expect(actions).toHaveLength(1);

		const [send] = actions as Extract<Action, { type: 'send' }>[];

		expect(send?.text).toBe('Check the dev server logs.');
		expect(send?.note).toContain('api died (exit 1)');
		expect(send?.note).toContain('"Why were they failing?"');
	});

	// Seen in QA: a resumed session is idle a moment after it starts; its first message still gets the note.
	it('forward to a session started with nothing sent yet — still starting or already idle → the note too', async () => {
		const context = createToolContext();
		const state = context.tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'idle',
			isFresh: true,
		};

		await executeTool(
			'forward',
			{ text: 'Check the logs.' },
			{
				...context.tools,
				forwardTo: 'store-front/main',
				recentUtterances: ['restart the servers'],
			},
		);

		expect((context.actions[0] as Extract<Action, { type: 'send' }>).note).toContain(
			'restart the servers',
		);
	});

	it('a session that has had its first message, or has one queued → no note', async () => {
		const idleContext = createToolContext({ devServers: diedServers });

		await executeTool(
			'send_to',
			{ ref: 'store-front/main', text: 'Check the logs.' },
			{ ...idleContext.tools, recentUtterances: ['x'] },
		);

		expect(idleContext.actions[0]).not.toHaveProperty('note');

		const busyContext = createToolContext();
		const state = busyContext.tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'starting',
			isFresh: true,
			queue: [{ id: 'q', text: 'first', at: 0 }],
		};

		await executeTool(
			'send_to',
			{ ref: 'store-front/main', text: 'second' },
			{ ...busyContext.tools, recentUtterances: ['x'] },
		);

		expect(busyContext.actions[0]).not.toHaveProperty('note');
	});

	it('nothing down and nothing said before → no note', async () => {
		const { tools, actions } = createToolContext();

		await executeTool('send_to', { ref: 'checkout-api/main', text: 'Run the tests.' }, tools);

		expect(actions[0]).toEqual({ type: 'send', ref: 'checkout-api/main', text: 'Run the tests.' });
	});
});

describe('Voice OS note through the real reducer', () => {
	const createStoppedStore = () => {
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: ['store-front/main', 'checkout-api/main'].map((ref) => ({
				ref,
				label: ref,
				branch: '',
				cwd: '/w',
				dirs: [],
				isPinned: false,
			})),
		});
		const sent: Action[] = [];
		const tools: ToolContext = {
			getState: () => store.state,
			dispatch: (action) => {
				sent.push(action);
				store.dispatch(action);
			},
			readHistory: () => [],
			now: () => 0,
			asks: [],
			mute: () => {},
			saveDebugNote: () => {},
			recentUtterances: ['why were they failing?'],
		};

		return { tools, sent };
	};

	const listNoteFlags = (sent: Action[]) =>
		sent.map((action) => (action.type === 'send' ? Boolean(action.note) : null));

	it('two messages to the same stopped session in one turn → only the first carries the note', async () => {
		const { tools, sent } = createStoppedStore();

		await executeTool('send_to', { ref: 'store-front/main', text: 'Check the logs.' }, tools);
		await executeTool('send_to', { ref: 'store-front/main', text: 'Then fix it.' }, tools);

		expect(listNoteFlags(sent)).toEqual([true, false]);
	});

	// Each is a separate Claude starting from nothing: each needs its own context.
	it('two different stopped sessions → each gets its note', async () => {
		const { tools, sent } = createStoppedStore();

		await executeTool('send_to', { ref: 'store-front/main', text: 'Check the logs.' }, tools);
		await executeTool('send_to', { ref: 'checkout-api/main', text: 'Check the logs.' }, tools);

		expect(listNoteFlags(sent)).toEqual([true, true]);
	});

	// The QA sequence: a resumed session is idle before its first message arrives.
	it('started and already idle → its first message carries the note; the next does not', async () => {
		const { tools, sent } = createStoppedStore();

		tools.dispatch({ type: 'start_session', ref: 'store-front/main' });
		// An observation from the worker, not an action: the same store takes it.
		tools.dispatch({ type: 'session_started', ref: 'store-front/main' } as unknown as Action);
		sent.length = 0;
		await executeTool(
			'forward',
			{ text: 'List the files.' },
			{ ...tools, forwardTo: 'store-front/main' },
		);
		await executeTool(
			'forward',
			{ text: 'Only the tests.' },
			{ ...tools, forwardTo: 'store-front/main' },
		);

		expect(listNoteFlags(sent)).toEqual([true, false]);
	});
});

describe('stop guard: "this session"', () => {
	it('names the session on screen', async () => {
		const { tools, actions } = createToolContext();

		await executeTool(
			'stop_session',
			{ ref: 'store-front/main' },
			{ ...tools, utterance: 'And end this session.', screen: 'store-front/main' },
		);

		expect(actions).toEqual([{ type: 'stop_session', ref: 'store-front/main' }]);
	});

	it('is not another session', async () => {
		const { tools, actions } = createToolContext();

		const result = await executeTool(
			'stop_session',
			{ ref: 'store-front/wrk1' },
			{ ...tools, utterance: 'end this session', screen: 'store-front/main' },
		);

		expect(result.ok).toBe(false);
		expect(actions).toEqual([]);
	});

	it('a session named beats "this one"', async () => {
		const { tools, actions } = createToolContext();

		const wrongResult = await executeTool(
			'stop_session',
			{ ref: 'store-front/main' },
			{ ...tools, utterance: 'Stop the checkout one, not this one.', screen: 'store-front/main' },
		);

		expect(wrongResult.ok).toBe(false);

		await executeTool(
			'stop_session',
			{ ref: 'checkout-api/main' },
			{ ...tools, utterance: 'Stop the checkout one, not this one.', screen: 'store-front/main' },
		);

		expect(actions).toEqual([{ type: 'stop_session', ref: 'checkout-api/main' }]);
	});

	it('on Mission Control there is no "this session"', async () => {
		const { tools, actions } = createToolContext();

		const result = await executeTool(
			'stop_session',
			{ ref: 'store-front/main' },
			{ ...tools, utterance: 'end this session', screen: null },
		);

		expect(result.ok).toBe(false);
		expect(actions).toEqual([]);
	});
});

describe('spoken sends', () => {
	it('forward and send_to mark the words spoken when the kernel heard them', async () => {
		const { tools, actions } = createToolContext();

		await executeTool(
			'forward',
			{ text: 'Run the tests.' },
			{ ...tools, forwardTo: 'store-front/main', isSpoken: true },
		);
		await executeTool(
			'send_to',
			{ ref: 'store-front/wrk1', text: 'Run the tests.' },
			{ ...tools, isSpoken: false },
		);

		expect(actions).toEqual([
			{ type: 'send', ref: 'store-front/main', text: 'Run the tests.', isSpoken: true },
			{ type: 'send', ref: 'store-front/wrk1', text: 'Run the tests.' },
		]);
	});
});

describe('tools that replaced the fast path', () => {
	const permission: PendingAsk = {
		id: 'p1',
		ref: 'store-front/main',
		at: 1,
		kind: 'permission',
		toolName: 'Bash',
		summary: 'run git push',
		input: {},
		suggestions: [],
	};
	const plan: PendingAsk = {
		id: 'l1',
		ref: 'store-front/main',
		at: 1,
		kind: 'plan',
		input: {},
		plan: 'x',
	};
	const question: PendingAsk = {
		id: 'q1',
		ref: 'store-front/main',
		at: 1,
		kind: 'question',
		input: {},
		questions: [
			{ question: 'Which?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
		],
	};

	it('answer a permission heard when the words were said', async () => {
		const { tools, actions } = createToolContext({ asks: [permission] });

		expect(
			await executeTool(
				'answer',
				{ ref: 'store-front/main', decision: 'yes', text: '' },
				{ ...tools, asks: [permission] },
			),
		).toEqual({ ok: true, content: 'answered store-front/main' });
		expect(actions).toEqual([{ type: 'answer_permission', askId: 'p1', decision: 'allow' }]);
	});

	it('answer never lands on an ask that opened after the words were said', async () => {
		const { tools, actions } = createToolContext({ asks: [permission] });

		const result = await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'yes', text: '' },
			{ ...tools, asks: [] },
		);

		expect(result.ok).toBe(false);
		expect(actions).toEqual([]);
	});

	it('a second permission on the same session after the one heard → the new one is not answered', async () => {
		const second = { ...permission, id: 'p2', summary: 'rm -rf dist' };
		const { tools, actions } = createToolContext({ asks: [second] });

		expect(
			(
				await executeTool(
					'answer',
					{ ref: 'store-front/main', decision: 'yes', text: '' },
					{ ...tools, asks: [permission] },
				)
			).ok,
		).toBe(false);
		expect(actions).toEqual([]);
	});

	it('an unknown decision → refused, nothing dispatched', async () => {
		const { tools, actions } = createToolContext({ asks: [permission] });

		expect(
			(
				await executeTool(
					'answer',
					{ ref: 'store-front/main', decision: 'maybe', text: '' },
					{ ...tools, asks: [permission] },
				)
			).ok,
		).toBe(false);
		expect(actions).toEqual([]);
	});

	it('answer an ask settled meanwhile → refused, the developer is told', async () => {
		const { tools, actions } = createToolContext({ asks: [] });

		const result = await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'yes', text: '' },
			{ ...tools, asks: [permission] },
		);

		expect(result).toMatchObject({
			ok: false,
			content: expect.stringContaining('already settled'),
		});
		expect(actions).toEqual([]);
	});

	it('forward / send_to refuse a session waiting on a permission or plan (words would deny it); a question takes words', async () => {
		for (const ask of [permission, plan]) {
			const { tools, actions } = createToolContext({ asks: [ask] });
			expect(
				(await executeTool('forward', { text: 'yes' }, { ...tools, forwardTo: 'store-front/main' }))
					.content,
			).toContain('with the answer tool');
			expect(
				(await executeTool('send_to', { ref: 'store-front/main', text: 'yes' }, tools)).ok,
			).toBe(false);
			expect(actions).toEqual([]);
		}

		const { tools, actions } = createToolContext({ asks: [question] });

		await executeTool('forward', { text: 'B please' }, { ...tools, forwardTo: 'store-front/main' });

		expect(actions).toHaveLength(1);
	});

	it('interrupt: the session on screen or one named, only while it works', async () => {
		const createRunningContext = (ref: string) => {
			const context = createToolContext();
			const state = context.tools.getState();
			state.sessions[ref] = { ...state.sessions[ref]!, status: 'running' };

			return context;
		};

		const onScreenContext = createRunningContext('store-front/main');

		await executeTool(
			'interrupt',
			{ ref: 'store-front/main' },
			{ ...onScreenContext.tools, utterance: 'stop', screen: 'store-front/main' },
		);

		expect(onScreenContext.actions).toEqual([{ type: 'interrupt', ref: 'store-front/main' }]);

		const offScreenContext = createRunningContext('store-front/wrk1');

		expect(
			(
				await executeTool(
					'interrupt',
					{ ref: 'store-front/wrk1' },
					{ ...offScreenContext.tools, utterance: 'stop', screen: null },
				)
			).ok,
		).toBe(false);

		await executeTool(
			'interrupt',
			{ ref: 'store-front/wrk1' },
			{ ...offScreenContext.tools, utterance: 'stop work 1', screen: null },
		);

		expect(offScreenContext.actions).toEqual([{ type: 'interrupt', ref: 'store-front/wrk1' }]);

		const idleContext = createToolContext();

		await executeTool(
			'interrupt',
			{ ref: 'store-front/main' },
			{ ...idleContext.tools, utterance: 'stop', screen: 'store-front/main' },
		);

		expect(idleContext.actions).toEqual([]);
	});

	it("mute calls Voice OS's mute and dispatches nothing", async () => {
		let muted = 0;
		const { tools, actions } = createToolContext();

		await executeTool('mute', {}, { ...tools, mute: () => muted++ });

		expect(muted).toBe(1);
		expect(actions).toEqual([]);
	});

	it("debug_note hands the words to Voice OS's note-taker and dispatches nothing; an empty one is refused", async () => {
		const notes: string[] = [];
		const { tools, actions } = createToolContext();

		expect(
			await executeTool(
				'debug_note',
				{ text: ' it re-asked the question ' },
				{ ...tools, saveDebugNote: (text) => notes.push(text) },
			),
		).toMatchObject({ ok: true });
		expect(
			(
				await executeTool(
					'debug_note',
					{ text: '' },
					{ ...tools, saveDebugNote: (text) => notes.push(text) },
				)
			).ok,
		).toBe(false);
		expect(notes).toEqual(['it re-asked the question']);
		expect(actions).toEqual([]);
		expect(describeToolCall({ name: 'debug_note', input: { text: 'it re-asked' }, ok: true })).toBe(
			'debug_note "it re-asked"',
		);
	});

	it('dev_offer: a fresh offer is fixed, a stale one refused; declining needs no freshness', async () => {
		const fresh = createToolContext({
			devOffer: { ref: 'store-front/main', servers: ['api'], at: 0 },
		});

		await executeTool('dev_offer', { accept: true }, { ...fresh.tools, now: () => 1000 });

		expect(fresh.actions).toEqual([{ type: 'fix_dev', ref: 'store-front/main' }]);

		const stale = createToolContext({
			devOffer: { ref: 'store-front/main', servers: ['api'], at: 0 },
		});

		expect(
			(await executeTool('dev_offer', { accept: true }, { ...stale.tools, now: () => 10 * 60_000 }))
				.ok,
		).toBe(false);

		await executeTool('dev_offer', { accept: false }, { ...stale.tools, now: () => 10 * 60_000 });

		expect(stale.actions).toEqual([{ type: 'dismiss_dev_offer' }]);
	});

	it('allow_denied lets the newest block of that session through once', async () => {
		const { tools, actions } = createToolContext({
			denials: [
				{ id: 'd0', ref: 'store-front/main', toolName: 'Bash', summary: 'rm -rf build', at: 0 },
				{ id: 'd1', ref: 'store-front/main', toolName: 'Bash', summary: 'rm -rf dist', at: 1 },
				{ id: 'd2', ref: 'checkout-api/main', toolName: 'Bash', summary: 'rm -rf out', at: 2 },
			],
		});

		await executeTool('allow_denied', { ref: 'store-front/main' }, tools);

		expect(actions).toEqual([{ type: 'allow_denied', denialId: 'd1' }]);
		expect((await executeTool('allow_denied', { ref: 'store-front/wrk1' }, tools)).ok).toBe(false);
	});

	it('every new tool changes something, is silent on success, and is remembered', () => {
		for (const name of ['answer', 'interrupt', 'mute', 'dev_offer', 'allow_denied'] as const) {
			expect(MUTATING_TOOLS).toContain(name);
			expect(isSilentCall(name, {})).toBe(true);
		}

		expect(
			describeToolCall({ name: 'answer', input: { ref: 'x/main', decision: 'no' }, ok: true }),
		).toBe('answer no x/main');
		expect(describeToolCall({ name: 'dev_offer', input: { accept: true }, ok: true })).toBe(
			'dev_offer accepted',
		);
	});
});

describe('describeSession: what it waits on, what it was asked', () => {
	it('pending, asked and blocked are told apart; its last messages and how long it has worked are there', () => {
		const { tools } = createToolContext({
			asks: [
				{
					id: 'q1',
					ref: 'store-front/main',
					at: 1,
					kind: 'question',
					input: {},
					questions: [
						{
							question: 'Which table?',
							multiSelect: false,
							options: [{ label: 'New' }, { label: 'Reuse' }],
						},
					],
				},
			],
			denials: [
				{ id: 'd1', ref: 'store-front/main', toolName: 'Bash', summary: 'rm -rf dist', at: 1 },
			],
		});
		const state = tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'running',
			requests: [{ text: 'set up the wrk3 worktree', at: 0 }],
			needsUser: { text: 'asks: push it?', at: 60_000 },
		};

		expect(
			describeSession({ state, ref: 'store-front/main', isDetailed: false, now: 180_000 }),
		).toMatchObject({
			last_messages_to_it: ['set up the wrk3 worktree'],
			working_for: '3m',
			pending: { kind: 'question', question: 'Which table?', options: ['New', 'Reuse'] },
			asked: 'asks: push it?',
			asked_ago: '2m',
			blocked: 'rm -rf dist',
		});
	});

	it('while it works, the detailed view shows its latest steps', () => {
		const { tools } = createToolContext();
		const state = tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'running',
			stream: [
				{ id: 'u', at: 0, kind: 'user', text: 'set up wrk3' },
				{ id: 't1', at: 1, kind: 'tool', name: 'Bash', summary: 'crew add worktree signals wrk3' },
				{
					id: 't2',
					at: 2,
					kind: 'tool',
					name: 'Bash',
					summary: 'crew setup status store-front/wrk3',
				},
			],
		} as never;

		expect(
			describeSession({ state, ref: 'store-front/main', isDetailed: true, now: 5 }).recent,
		).toEqual([
			'developer: set up wrk3',
			'step: Bash crew add worktree signals wrk3',
			'step: Bash crew setup status store-front/wrk3',
		]);
	});
});
