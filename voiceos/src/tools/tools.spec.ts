import { createToolContext, INSTRUCTION_ACK } from '../../test/support/tool-context.js';
import { englishJudge, judgeAlways } from '../../test/support/english-judge.js';
import { describe, expect, it } from 'bun:test';
import type { NoteWords } from '../memory/notes.js';
import { formatAge } from '../state/working.js';
import { GENERAL_NOTES } from '../shared/notes.js';
import { createNullNotes } from '../../test/support/notes.js';
import {
	GRID,
	type Action,
	type ListenMode,
	type PendingAsk,
	type Session,
	type State,
	type VoiceEntry,
} from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { Store } from '../state/store.js';
import type { DebugNoteWords } from '../memory/debug-notes.js';
import {
	buildNotesPathNote,
	buildSessionNote,
	isDuplicateSend,
	isMisroutedToSetup,
} from './send.js';
import { executeTool, type ToolContext } from './tools.js';
import { TAKEN_BACK } from './queued.js';
import { decideEnding, describeToolCall, isAnsweredByForward, isSilentCall } from './call-lines.js';
import { TOOL_DEFINITIONS, listToolsFor, MUTATING_TOOLS } from './definitions.js';
import { findSessionsNamedIn, isSessionNamed } from './session-naming.js';
import { describeSession } from './session-view.js';
import { carriesWords } from '../router/kernel.js';
import { readOptionReply } from './answer.js';
import type { QuestionAsk } from '../shared/questions.js';

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
		).toMatchObject({ ok: true, content: 'sent to store-front/wrk1' });
		expect(actions).toEqual([
			{ type: 'send', ref: 'store-front/wrk1', text: 'run the tests', ack: INSTRUCTION_ACK },
		]);
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

	// Debug note 14: "go back to speak main" went to speak/main, not the session named Speak Main.
	it("the developer's own name said → that session, not a worktree whose ref sounds the same", async () => {
		const { tools, actions } = createToolContext({
			names: { 'store-front/wrk1': 'Store Front Main' },
		});

		await executeTool(
			'switch_view',
			{ ref: 'store-front/main' },
			{ ...tools, utterance: 'Can you go back to store front main?' },
		);
		await executeTool(
			'switch_view',
			{ ref: 'checkout-api/main' },
			{ ...tools, utterance: 'Switch to checkout api main.' },
		);
		// The named session mentioned beside another target: not what they asked to see.
		await executeTool(
			'switch_view',
			{ ref: 'checkout-api/main' },
			{
				...tools,
				utterance: 'Tell store front main the tests pass, then switch to checkout api main.',
			},
		);

		expect(actions).toEqual([
			{ type: 'switch_view', view: { kind: 'session', ref: 'store-front/wrk1' } },
			{ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } },
			{ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } },
		]);
	});

	// Debug note 25: "go back to speak main" went to the screen before, not Speak Main.
	it('"go back to X" → X; a bare "go back", or X named among other words → back', async () => {
		const { tools, actions } = createToolContext({
			names: { 'store-front/wrk1': 'Store Front Main' },
		});

		await executeTool(
			'go_back',
			{},
			{ ...tools, utterance: 'Can you go back to store front main?' },
		);
		await executeTool('go_back', {}, { ...tools, utterance: 'Go back.' });
		await executeTool(
			'go_back',
			{},
			{
				...tools,
				utterance: 'Go back, and later ask checkout api main how the retry work is going.',
			},
		);

		expect(actions).toEqual([
			{ type: 'switch_view', view: { kind: 'session', ref: 'store-front/wrk1' } },
			{ type: 'go_back' },
			{ type: 'go_back' },
		]);
	});

	it('switch_view null → Mission Control', async () => {
		const { tools, actions } = createToolContext();

		await executeTool('switch_view', { ref: null }, tools);

		expect(actions).toEqual([{ type: 'switch_view', view: { kind: 'machines' } }]);
	});

	it('activate on an active session → no dispatch, says so', async () => {
		const { tools, actions } = createToolContext();

		expect(await executeTool('activate', { name: 'store-front/main' }, tools)).toMatchObject({
			ok: true,
			content: 'store-front/main is already active',
		});
		expect(actions).toEqual([]);
	});

	it('activate on an inactive one → activated, Voice OS offers the switch', async () => {
		const { tools, actions } = createToolContext({ active: ['store-front/main'] });

		await executeTool('activate', { name: 'checkout-api/main' }, tools);

		expect(actions).toEqual([{ type: 'activate', ref: 'checkout-api/main', announce: true }]);
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

	it('full ref → that session', () => {
		expect(findNamed('end store-front/main')).toEqual(['store-front/main']);
	});
});

describe('isSessionNamed', () => {
	const isNamed = (ref: string, utterance: string, order: string[]) => {
		const text = ` ${utterance} `;

		return isSessionNamed({ ref, text, words: new Set(utterance.split(' ')), order });
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
});

describe('deactivate guard', () => {
	it('ambiguous utterance → refused, nothing dispatched', async () => {
		const { tools, actions } = createToolContext();

		const result = await executeTool(
			'deactivate',
			{ ref: 'store-front/main' },
			{ ...tools, utterance: 'End the main session.' },
		);

		expect(result.ok).toBe(false);
		expect(result.content).toContain('Ask which one');
		expect(actions).toEqual([]);
	});

	it('named session → deactivated', async () => {
		const { tools, actions } = createToolContext();

		await executeTool(
			'deactivate',
			{ ref: 'store-front/wrk1' },
			{ ...tools, utterance: 'stop work one' },
		);

		expect(actions).toEqual([{ type: 'deactivate', ref: 'store-front/wrk1' }]);
	});

	it('follow-up answer naming the session → deactivated', async () => {
		const { tools, actions } = createToolContext();

		await executeTool(
			'deactivate',
			{ ref: 'checkout-api/main' },
			{ ...tools, recentUtterances: ['End the main session.'], utterance: 'the checkout one' },
		);

		expect(actions).toEqual([{ type: 'deactivate', ref: 'checkout-api/main' }]);
	});

	it('clear command after one about another session → deactivated, the earlier one ignored', async () => {
		const { tools, actions } = createToolContext();

		await executeTool(
			'deactivate',
			{ ref: 'store-front/wrk1' },
			{ ...tools, recentUtterances: ['stop the checkout session'], utterance: 'stop work one' },
		);

		expect(actions).toEqual([{ type: 'deactivate', ref: 'store-front/wrk1' }]);
	});
});

describe('a message the session is already working on', () => {
	const withSession = (patch: Partial<Session>) => {
		const context = createToolContext();
		const state = context.tools.getState();
		state.sessions['store-front/main'] = { ...state.sessions['store-front/main']!, ...patch };

		return { ...context, session: state.sessions['store-front/main']! };
	};

	const userItem = (text: string) => ({ id: 'u1', at: 1, kind: 'user' as const, text });

	it('the running turn was sent the same words (spacing and case aside) → a duplicate', () => {
		const { session } = withSession({
			status: 'running',
			stream: [userItem('Explain it  in more detail.')],
		});

		expect(isDuplicateSend({ session, text: ' explain it in more detail. ' })).toBe(true);
		expect(isDuplicateSend({ session, text: 'Explain the other file.' })).toBe(false);
	});

	it('a turn blocked on a permission is still working on its words → a duplicate', () => {
		const { session } = withSession({
			status: 'blocked',
			stream: [userItem('Push the branch.')],
		});

		expect(isDuplicateSend({ session, text: 'Push the branch.' })).toBe(true);
	});

	it('the same words after that turn ended → not a duplicate: a repeat is deliberate', () => {
		const { session } = withSession({ status: 'idle', stream: [userItem('Run the tests again.')] });

		expect(isDuplicateSend({ session, text: 'Run the tests again.' })).toBe(false);
	});

	it('the words wait in the queue, alone or merged onto the end of a follow-up → a duplicate', () => {
		const { session } = withSession({
			status: 'running',
			queue: [
				{ id: 'q1', at: 1, text: 'Check the logs. Then fix the test.', isFollowUp: true },
				{ id: 'q2', at: 2, text: 'Run the linter.' },
			],
		});

		expect(isDuplicateSend({ session, text: 'Then fix the test.' })).toBe(true);
		expect(isDuplicateSend({ session, text: 'Run the linter.' })).toBe(true);
		expect(isDuplicateSend({ session, text: 'Check the logs.' })).toBe(false);
	});

	it('words that only end another queued message → sent: short replies are not swallowed', () => {
		const { session } = withSession({
			status: 'running',
			queue: [
				{ id: 'q1', at: 1, text: 'Then prefix it.', isFollowUp: true },
				{ id: 'q2', at: 2, text: 'Rename it and test.' },
			],
		});

		expect(isDuplicateSend({ session, text: 'fix it.' })).toBe(false);
		expect(isDuplicateSend({ session, text: 'test.' })).toBe(false);
	});

	it('forward and send_to of a duplicate → refused, nothing sent, no interrupt', async () => {
		const { tools, actions } = withSession({
			status: 'running',
			stream: [userItem('Explain it in more detail.')],
		});

		const forwarded = await executeTool(
			'forward',
			{ text: 'Explain it in more detail.' },
			{ ...tools, forwardTo: 'store-front/main', isSpoken: true },
		);
		const sent = await executeTool(
			'send_to',
			{ ref: 'store-front/main', text: 'Explain it in more detail.' },
			tools,
		);

		expect(forwarded).toMatchObject({ ok: false });
		expect(String(forwarded.content)).toContain('already sent');
		expect(sent.ok).toBe(false);
		expect(actions).toEqual([]);
	});

	it('a forward that went through, with nothing failing beside it, is the whole answer', () => {
		const forwarded = { name: 'forward', input: {}, ok: true };

		expect(isAnsweredByForward([forwarded])).toBe(true);
		expect(isAnsweredByForward([{ ...forwarded, ok: false }])).toBe(false);
		expect(isAnsweredByForward([{ name: 'send_to', input: {}, ok: true }])).toBe(false);
		expect(isAnsweredByForward([forwarded, { name: 'crew_dev', input: {}, ok: false }])).toBe(
			false,
		);
		// A failed answer beside a forward is the kernel trying both: the forward is what happened.
		expect(isAnsweredByForward([forwarded, { name: 'answer', input: {}, ok: false }])).toBe(true);
		expect(isAnsweredByForward([forwarded, { name: 'send_to', input: {}, ok: false }])).toBe(false);
		expect(
			isAnsweredByForward([
				{ ...forwarded, ok: false },
				{ name: 'answer', input: {}, ok: false },
			]),
		).toBe(false);
	});
});

describe('forward', () => {
	it('offered only when routing captured a session to forward to', () => {
		expect(listToolsFor(null).some((tool) => tool.name === 'forward')).toBe(false);
		expect(listToolsFor('store-front/main')[0]?.name).toBe('forward');
	});

	// The order is part of what the kernel reads, and the evals passed on this one: a change here is a
	// change to the prompt, so it is deliberate and re-run through them.
	it('the tools in the order the kernel evals passed on, without and with other machines', () => {
		const names = (hasMachines: boolean) =>
			listToolsFor(null, hasMachines).map((tool): string => tool.name);
		const base = [
			'ignore_words',
			'read_state',
			'read_history',
			'send_to',
			'switch_view',
			'go_back',
			'play_missed',
			'activate',
			'deactivate',
			'list_sessions',
			'crew_dev',
			'answer',
			'interrupt',
			'queued_message',
			'mute',
			'dev_offer',
			'allow_denied',
			'debug_note',
			'note',
			'read_notes',
			'open_doc',
			'hands_free',
			'rename_session',
		];

		expect(names(false)).toEqual(base);
		expect(names(true)).toEqual([
			...base.filter((name) => name !== 'switch_view'),
			'switch_view',
			'rename_machine',
		]);
	});

	it('history is offered on Mission Control, not while a session is on screen: that session holds its own', () => {
		const hasHistory = (forwardTo: string | null) =>
			listToolsFor(forwardTo).some((tool) => tool.name === 'read_history');

		expect(hasHistory(null)).toBe(true);
		expect(hasHistory('store-front/main')).toBe(false);
	});

	it('a continuation → both halves joined as said, the new part as rest; without earlier words, a plain send', async () => {
		const { tools, actions } = createToolContext();
		const forward = (recentUtterances: string[]) =>
			executeTool(
				'forward',
				{ kind: 'instruction', continues: true },
				{
					...tools,
					forwardTo: 'store-front/main',
					utterance: 'the checkout worker.',
					recentUtterances,
				},
			);

		await forward(['Check the logs for the timeout errors in']);
		await forward([]);

		expect(actions[0]).toMatchObject({
			type: 'send',
			text: 'Check the logs for the timeout errors in the checkout worker.',
			continues: { rest: 'the checkout worker.' },
		});
		expect(actions[1]).toMatchObject({ type: 'send', text: 'the checkout worker.' });
		expect(actions[1]).not.toHaveProperty('continues');
		expect(actions.some((action) => action.type === 'send' && action.aside)).toBe(false);
	});

	it.each([
		['Actually, stop the refactor and fix the login bug first.', false],
		['Cancel that and do the seed script.', false],
		['Stop.', true],
		['Stop the tests.', true],
		['Stop and wait.', true],
		['Stop, first let me check.', true],
		['Cancel that and hold on.', true],
		['Stop and let me look at it.', true],
		["Stop, I'll fix it myself instead.", true],
	])('interrupt on %p → allowed: %p', async (utterance, isAllowed) => {
		const { tools } = createToolContext();
		const state = tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'running',
		};

		const result = await executeTool(
			'interrupt',
			{ ref: 'store-front/main' },
			{ ...tools, screen: 'store-front/main', utterance },
		);

		expect(result.ok).toBe(isAllowed);
	});

	it('asked aside while the developer is in the Discord voice channel → the note says so', async () => {
		const { tools, actions } = createToolContext({
			discord: {
				isConnected: true,
				isHearing: true,
				isOwnerIn: true,
				channelName: 'Voice OS',
				mode: 'hands-free',
			},
		});
		const state = tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'running',
		};

		await executeTool(
			'forward',
			{ kind: 'question' },
			{ ...tools, forwardTo: 'store-front/main', utterance: 'Which file?' },
		);

		expect(actions[0]).toMatchObject({ type: 'send', aside: true });
		expect((actions[0] as Extract<Action, { type: 'send' }>).note).toContain(
			'Discord voice channel',
		);
	});

	it('to a working session: a spoken question aside is marked spoken; a continuation is never aside', async () => {
		const { tools, actions } = createToolContext();
		const state = tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'running',
		};
		const context = {
			...tools,
			forwardTo: 'store-front/main',
			isSpoken: true,
			recentUtterances: ['Which file'],
		};

		await executeTool('forward', { kind: 'question' }, { ...context, utterance: 'Which file?' });
		await executeTool(
			'forward',
			{ kind: 'question', continues: true },
			{ ...context, utterance: 'holds the retry?' },
		);

		expect(actions[0]).toMatchObject({ type: 'send', aside: true, isSpoken: true });
		expect(actions[1]).toMatchObject({
			type: 'send',
			text: 'Which file holds the retry?',
			continues: { rest: 'holds the retry?', isAside: true },
		});
		expect(actions[1]).not.toHaveProperty('aside');
	});

	it('a held switch: "choose" is refused; "no, do X" carries X', async () => {
		const held: PendingAsk = {
			id: 'r2',
			ref: 'store-front/main',
			at: 1,
			kind: 'redirect',
			text: 'Fix the login bug.',
			target: 's1',
		};
		const choose = createToolContext({ asks: [held] });
		const no = createToolContext({ asks: [held] });

		const refused = await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'choose', text: 'x' },
			{ ...choose.tools, asks: [held] },
		);
		await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'no', text: 'Do the seed script.' },
			{ ...no.tools, asks: [held] },
		);

		expect(refused.ok).toBe(false);
		expect(no.actions).toEqual([
			{ type: 'answer_redirect', askId: 'r2', isApproved: false, message: 'Do the seed script.' },
		]);
		expect(
			describeSession({
				state: createToolContext({ asks: [held] }).tools.getState(),
				ref: 'store-front/main',
				isDetailed: false,
				now: 0,
			}).pending,
		).toEqual({ kind: 'confirm', switch_to: 'Fix the login bug.' });
	});

	it('a redirect → its kind reaches the reducer', async () => {
		const { tools, actions } = createToolContext();

		await executeTool(
			'forward',
			{ text: 'Stop that and fix the login bug.', kind: 'redirect' },
			{ ...tools, forwardTo: 'store-front/main' },
		);

		expect(actions[0]).toMatchObject({ type: 'send', ack: { kind: 'redirect' } });
	});

	it('a held switch: a plain yes (with words joined) switches; "yes but wait" does not', async () => {
		const held: PendingAsk = {
			id: 'r1',
			ref: 'store-front/main',
			at: 1,
			kind: 'redirect',
			text: 'Fix the login bug.',
			target: 's1',
		};
		const yes = createToolContext({ asks: [held] });
		const hedged = createToolContext({ asks: [held] });

		await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'yes', text: 'And use staging.' },
			{ ...yes.tools, asks: [held], utterance: 'Yes, and use staging.' },
		);
		const refused = await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'yes', text: '' },
			{ ...hedged.tools, asks: [held], utterance: 'Yes but wait a second.' },
		);

		expect(yes.actions).toEqual([
			{ type: 'answer_redirect', askId: 'r1', isApproved: true, message: 'And use staging.' },
		]);
		expect(refused.ok).toBe(false);
		expect(hedged.actions).toEqual([]);
	});

	it('an instruction or a question → its kind on the send, for the reducer to act on', async () => {
		const { tools, actions } = createToolContext();
		const forward = (input: Record<string, unknown>) =>
			executeTool('forward', input, { ...tools, forwardTo: 'store-front/main' });

		await forward({ text: 'Revert the last change.', kind: 'instruction' });
		await forward({ text: 'Why revert the last change?', kind: 'question' });

		expect(actions.map((action) => (action.type === 'send' ? action.ack : null))).toEqual([
			{ kind: 'instruction' },
			{ kind: 'question' },
		]);
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
			{ type: 'send', ref: 'store-front/wrk1', text: 'why is this so slow', ack: INSTRUCTION_ACK },
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

describe('notes', () => {
	const withNotes = () => {
		const saved: NoteWords[] = [];
		const { tools } = createToolContext();

		return {
			saved,
			tools: {
				...tools,
				notes: {
					...createNullNotes(),
					save: (words: NoteWords) => {
						saved.push(words);
					},
					read: (workspace: string, limit: number) =>
						workspace === 'store-front'
							? Array.from(
									{ length: 12 },
									(_, index) => `- 2026-09-27 07:${String(index).padStart(2, '0')} — idea ${index}`,
								).slice(-limit)
							: [],
				},
			},
		};
	};

	it('saved to the workspace on screen, a named one, or the general notes', async () => {
		const { saved, tools } = withNotes();

		await executeTool(
			'note',
			{ text: 'try a tone', workspace: null },
			{ ...tools, screen: 'store-front/main' },
		);
		await executeTool(
			'note',
			{ text: 'check retries', workspace: 'Checkout API' },
			{ ...tools, screen: null },
		);
		await executeTool('note', { text: 'loose idea', workspace: null }, { ...tools, screen: null });
		await executeTool(
			'note',
			{ text: 'x', workspace: 'no such space' },
			{ ...tools, screen: null },
		);

		expect(saved).toEqual([
			{ workspace: 'store-front', text: 'try a tone' },
			{ workspace: 'checkout-api', text: 'check retries' },
			{ workspace: GENERAL_NOTES, text: 'loose idea' },
			{ workspace: GENERAL_NOTES, text: 'x' },
		]);
	});

	it('a name that matches no workspace is said to land in the general notes', async () => {
		const { tools } = withNotes();

		expect(
			(await executeTool('note', { text: 'x', workspace: 'no such space' }, tools)).content,
		).toContain('Noted in your general notes');
		expect((await executeTool('note', { text: 'x', workspace: 'storefront' }, tools)).content).toBe(
			"noted in store-front's notes",
		);
	});

	it('a workspace known only by its notes, or the general notes, named aloud → saved there', async () => {
		const { saved, tools } = withNotes();
		const withInfra = {
			...tools,
			getState: () => ({ ...tools.getState(), notes: { 'infra-ops': ['- x'] } }),
		};

		expect(
			(await executeTool('note', { text: 'rotate keys', workspace: 'infra ops' }, withInfra))
				.content,
		).toBe("noted in infra-ops's notes");
		expect(
			(await executeTool('note', { text: 'loose', workspace: 'general' }, withInfra)).content,
		).toBe("noted in general's notes");
		expect(saved).toEqual([
			{ workspace: 'infra-ops', text: 'rotate keys' },
			{ workspace: GENERAL_NOTES, text: 'loose' },
		]);
	});

	it('"general" spoken with a workspace of that name → that workspace, not the general notes', async () => {
		const { saved, tools } = withNotes();
		const withGeneral = {
			...tools,
			getState: () => ({
				...tools.getState(),
				order: [...tools.getState().order, 'general/main'],
			}),
		};

		const onlyItsNotes = {
			...tools,
			getState: () => ({
				...tools.getState(),
				notes: { [GENERAL_NOTES]: ['- a'], general: ['- b'] },
			}),
		};

		await executeTool('note', { text: 'x', workspace: 'general' }, withGeneral);
		await executeTool('note', { text: 'y', workspace: 'general' }, onlyItsNotes);

		expect(saved).toEqual([
			{ workspace: 'general', text: 'x' },
			{ workspace: 'general', text: 'y' },
		]);
	});

	it('a save that fails is said to have failed; reading an unknown workspace asks which', async () => {
		const { tools } = withNotes();
		const broken = {
			...tools,
			notes: {
				...tools.notes,
				save: () => {
					throw new Error('EACCES');
				},
			},
		};

		expect(await executeTool('note', { text: 'x', workspace: null }, broken)).toMatchObject({
			ok: false,
		});
		expect((await executeTool('read_notes', { workspace: 'no such space' }, tools)).ok).toBe(false);
	});

	it('an empty note is refused; the last ten are read back without their stamps', async () => {
		const { saved, tools } = withNotes();

		expect((await executeTool('note', { text: ' ', workspace: null }, tools)).ok).toBe(false);
		expect(saved).toEqual([]);
		expect(
			(
				await executeTool(
					'read_notes',
					{ workspace: null },
					{ ...tools, screen: 'store-front/wrk1' },
				)
			).content,
		).toBe(
			JSON.stringify({
				workspace: 'store-front',
				notes: Array.from({ length: 10 }, (_, index) => `idea ${index + 2}`),
				if_asked_for_work:
					"forward the developer's words to the session: it reads the notes file itself",
			}),
		);
		expect(
			(
				await executeTool(
					'read_notes',
					{ workspace: null },
					{ ...tools, screen: 'checkout-api/main' },
				)
			).content,
		).toBe('no notes in checkout-api yet');
	});
});

describe('the notes path for a session', () => {
	const diedServers = {
		'checkout-api/main': [
			{ name: 'api', port: 3000, url: null, state: 'died' as const, detail: 'exit 1' },
		],
	};
	const notesIn = (existing: string[]) => ({
		...createNullNotes(),
		pathFor: (workspace: string) => `/n/${workspace}.md`,
		has: (workspace: string) => existing.includes(workspace),
	});
	const sentNote = (actions: Action[]) =>
		(actions.find((action) => action.type === 'send') as Extract<Action, { type: 'send' }>)?.note;

	it('asked about "my notes" mid-conversation → the target\'s workspace notes path, nothing else', async () => {
		const { tools, actions } = createToolContext();
		const state = tools.getState();
		state.sessions['checkout-api/main'] = {
			...state.sessions['checkout-api/main']!,
			status: 'idle',
			isFresh: false,
		};

		await executeTool(
			'send_to',
			{ my_notes: true, ref: 'checkout-api/main', text: 'Go through my notes and pick one.' },
			{
				...tools,
				notes: notesIn(['checkout-api']),
				screen: 'store-front/main',
				utterance: 'checkout, go through my notes and pick one',
				recentUtterances: ['restart the servers'],
			},
		);

		expect(sentNote(actions)).toBe(
			"The developer's notes for checkout-api are in /n/checkout-api.md.",
		);
	});

	it('the first message to a session with servers down → the situation first, then the path', async () => {
		const { tools, actions } = createToolContext({ devServers: diedServers });

		await executeTool(
			'send_to',
			{ my_notes: true, ref: 'checkout-api/main', text: 'Go through my notes.' },
			{ ...tools, notes: notesIn([]), utterance: 'checkout, go through my notes' },
		);

		const note = sentNote(actions) ?? '';

		expect(
			note.startsWith(
				buildSessionNote({
					session: tools.getState().sessions['checkout-api/main']!,
					state: tools.getState(),
					recent: [],
				}) ?? 'missing',
			),
		).toBe(true);
		expect(
			note.endsWith(
				'\n\nThe developer has no notes for checkout-api yet (they would be in /n/checkout-api.md).',
			),
		).toBe(true);
	});

	it('a question aside to a working session carries it too', async () => {
		const { tools, actions } = createToolContext();
		const state = tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'running',
		};

		await executeTool(
			'forward',
			{ my_notes: true, text: 'Which of my notes is quickest?', kind: 'question' },
			{
				...tools,
				notes: notesIn([]),
				forwardTo: 'store-front/main',
				utterance: 'which of my notes is quickest?',
			},
		);

		expect(actions).toEqual([
			{
				type: 'send',
				ref: 'store-front/main',
				text: 'Which of my notes is quickest?',
				aside: true,
				note: 'The developer has no notes for store-front yet (they would be in /n/store-front.md).',
			},
		]);
	});

	it("the setup session reads the general notes; notes the kernel does not call the developer's are not given", () => {
		const notes = notesIn([GENERAL_NOTES]);

		expect(buildNotesPathNote({ ref: 'setup', isAsked: true, notes })).toBe(
			"The developer's notes for general are in /n/(general).md.",
		);
		expect(buildNotesPathNote({ ref: 'store-front/main', isAsked: false, notes })).toBeUndefined();
	});

	it('a session on another machine → the crew command, not a path it cannot read; nothing unasked', () => {
		const notes = notesIn([]);

		expect(buildNotesPathNote({ ref: 'vm1:store-front/main', isAsked: true, notes })).toBe(
			"The developer's notes for store-front are on the main machine: run `crew voice notes store-front` to read them.",
		);
		expect(buildNotesPathNote({ ref: 'vm1:setup', isAsked: true, notes })).toBe(
			"The developer's notes for general are on the main machine: run `crew voice notes` to read them.",
		);
		expect(
			buildNotesPathNote({ ref: 'vm1:store-front/main', isAsked: false, notes }),
		).toBeUndefined();
	});
});

describe('an answer to a question asked while the developer spoke', () => {
	it('is not its answer: nothing sent; asked before they spoke, it is', async () => {
		const ask = (askedAt: number) => {
			const context = createToolContext();
			context.tools.getState().sessions['checkout-api/main'] = {
				...context.tools.getState().sessions['checkout-api/main']!,
				status: 'idle',
				needsUser: { text: 'asks: did you mean another session?', at: askedAt },
			};

			return context;
		};

		const unheard = ask(5000);
		const heard = ask(3000);
		const input = { ref: 'checkout-api/main', decision: 'yes', text: 'That was for crew main.' };

		expect((await executeTool('answer', input, { ...unheard.tools, heardFrom: 4000 })).ok).toBe(
			false,
		);
		await executeTool('answer', input, { ...heard.tools, heardFrom: 4000 });

		expect(unheard.actions).toEqual([]);

		// Said aloud before they spoke (the turn went on, so needsUser came later): heard, answered.
		const spokenEarly = ask(5000);
		spokenEarly.tools.getState().spoken = [
			{
				id: 'l1',
				text: 'asks: push it?',
				source: 'narrator',
				at: 2000,
				ref: 'checkout-api/main',
				isAsking: true,
			},
		];
		await executeTool('answer', input, { ...spokenEarly.tools, heardFrom: 4000, now: () => 6000 });

		expect(spokenEarly.actions).toEqual([
			expect.objectContaining({ type: 'send', ref: 'checkout-api/main' }),
		]);

		// A question from its previous turn, answered already, says nothing about this one.
		const earlierTurn = ask(5000);
		const earlierState = earlierTurn.tools.getState();
		earlierState.spoken = [
			{
				id: 'l0',
				text: 'asks: first question?',
				source: 'narrator',
				at: 1000,
				ref: 'checkout-api/main',
				isAsking: true,
			},
		];
		earlierState.sessions['checkout-api/main'] = {
			...earlierState.sessions['checkout-api/main']!,
			requests: [{ text: 'yes, the first one', at: 2000 }],
		};

		expect(
			(
				await executeTool('answer', input, {
					...earlierTurn.tools,
					heardFrom: 4000,
					now: () => 6000,
				})
			).ok,
		).toBe(false);
		expect(earlierTurn.actions).toEqual([]);
		expect(heard.actions).toEqual([
			expect.objectContaining({ type: 'send', ref: 'checkout-api/main' }),
		]);
	});
});

describe('an activate that asks for more', () => {
	// checkout-api/main is the one not active: "start checkout" activates it.
	const createInactiveCheckout = () =>
		createToolContext({ active: ['store-front/main', 'store-front/wrk1'] });

	it('the judge hears nothing more than a start → no hint, in any language', async () => {
		const { tools } = createInactiveCheckout();
		const result = await executeTool(
			'activate',
			{ name: 'checkout-api/main' },
			{
				...tools,
				forwardTo: 'checkout-api/main',
				utterance: 'Starte checkout.',
				judge: judgeAlways('no'),
			},
		);

		expect(result.content).toBe('activated checkout-api/main; Voice OS said so: say nothing');
	});

	it('still activates, and tells the kernel to forward the rest', async () => {
		const { tools, actions } = createInactiveCheckout();
		const result = await executeTool(
			'activate',
			{ name: 'checkout-api/main' },
			{
				...tools,
				forwardTo: 'checkout-api/main',
				utterance: 'start checkout and tell me what you did last',
			},
		);

		expect(actions).toEqual([{ type: 'activate', ref: 'checkout-api/main', announce: true }]);
		expect(result.content).toBe(
			'activated checkout-api/main. The developer also asked it something: forward that part now — it waits until the session is up.',
		);
	});

	it('already active → nothing activated, and the rest is still asked for', async () => {
		const { tools, actions } = createToolContext();
		const result = await executeTool(
			'activate',
			{ name: 'store-front/main' },
			{ ...tools, utterance: 'start store front and tell me what you did last' },
		);

		expect(actions).toEqual([]);
		expect(result).toEqual({
			ok: true,
			content:
				'store-front/main is already active. The developer also asked it something: send_to store-front/main that part now.',
		});
	});

	it('from another screen it is send_to; two sessions named, or the words already sent → no hint', async () => {
		const start = async (patch: Partial<ToolContext>) => {
			const { tools } = createInactiveCheckout();

			return (await executeTool('activate', { name: 'checkout-api/main' }, { ...tools, ...patch }))
				.content;
		};

		const plain = 'activated checkout-api/main; Voice OS said so: say nothing';

		expect(
			await start({ forwardTo: null, utterance: 'start checkout and tell me what you did last' }),
		).toContain('send_to checkout-api/main that part');
		expect(await start({ utterance: 'start checkout and store front main' })).toBe(plain);
		expect(
			await start({
				utterance: 'start checkout and tell me what you did last',
				sentTo: new Set(['checkout-api/main']),
			}),
		).toBe(plain);
	});
});

describe('a question only announced', () => {
	const withHeldQuestion = (kind: 'ask' | 'line') => {
		const context = createToolContext();
		const state = context.tools.getState();
		state.sessions['checkout-api/main'] = {
			...state.sessions['checkout-api/main']!,
			status: kind === 'ask' ? 'blocked' : 'idle',
			needsUser: kind === 'line' ? { text: 'asks: cap the backoff?', at: 0 } : null,
			heldLine:
				kind === 'ask'
					? { id: 'h1', at: 0, missed: 0, isAnnounced: false, kind: 'ask', askId: 'q1' }
					: {
							id: 'h1',
							at: 0,
							missed: 0,
							isAnnounced: false,
							kind: 'line',
							text: 'asks: cap the backoff?',
							isAsking: true,
						},
		};
		state.asks =
			kind === 'ask'
				? [
						{
							id: 'q1',
							ref: 'checkout-api/main',
							at: 0,
							kind: 'question',
							input: {},
							questions: [{ question: 'Cap the backoff?', multiSelect: false, options: [] }],
						},
					]
				: [];
		context.tools.asks = state.asks;

		return context;
	};

	it('a bare yes from elsewhere answers nothing, sends nothing, and Voice OS offers the switch itself (both kinds)', async () => {
		for (const kind of ['ask', 'line'] as const) {
			const { tools, actions } = withHeldQuestion(kind);
			const bare = { ...tools, screen: null, forwardTo: null, utterance: 'yes' };
			const answered = await executeTool(
				'answer',
				{ ref: 'checkout-api/main', decision: 'yes', text: '' },
				bare,
			);
			const sent = await executeTool('send_to', { ref: 'checkout-api/main', text: 'Yes.' }, bare);

			expect(answered).toMatchObject({ ok: false, note: 'switch offered' });
			expect(String(answered.content)).toContain('say nothing');
			expect(sent.ok).toBe(false);
			expect(actions).toEqual([
				{ type: 'offer_switch', ref: 'checkout-api/main' },
				{ type: 'offer_switch', ref: 'checkout-api/main' },
			]);
		}
	});

	it("switching there: refused on a bare yes; allowed while Voice OS's offer for it is fresh, or when named", async () => {
		const offer = (ref: string, at: number) => ({ ref, at });
		const refused = withHeldQuestion('line');
		const offered = withHeldQuestion('line');
		const stale = withHeldQuestion('line');
		const elsewhere = withHeldQuestion('line');
		const named = withHeldQuestion('line');
		offered.tools.getState().switchOffer = offer('checkout-api/main', 175_000);
		stale.tools.getState().switchOffer = offer('checkout-api/main', 150_000);
		elsewhere.tools.getState().switchOffer = offer('store-front/main', 175_000);
		const yes = { screen: null, utterance: 'yes', now: () => 180_000 };

		for (const context of [refused, offered, stale, elsewhere]) {
			await executeTool('switch_view', { ref: 'checkout-api/main' }, { ...context.tools, ...yes });
		}

		await executeTool(
			'switch_view',
			{ ref: 'checkout-api/main' },
			{ ...named.tools, screen: null, utterance: 'open checkout api main' },
		);
		const switched = {
			type: 'switch_view',
			view: { kind: 'session', ref: 'checkout-api/main' },
		} as const;
		const offering = { type: 'offer_switch', ref: 'checkout-api/main' } as const;

		expect(refused.actions).toEqual([offering]);
		expect(stale.actions).toEqual([offering]);
		// Another switch already offered: no second question over it, the kernel says it in words.
		expect(elsewhere.actions).toEqual([]);
		expect(offered.actions).toEqual([switched]);
		expect(named.actions).toEqual([switched]);
	});

	it('"no" right after "Switch to …?" → not sent to anyone; "no, use the table" still goes', async () => {
		const context = createToolContext();
		context.tools.getState().switchOffer = { ref: 'checkout-api/main', at: 175_000 };
		const now = () => 180_000;

		const bare = await executeTool(
			'send_to',
			{ ref: 'checkout-api/main' },
			{ ...context.tools, now, utterance: 'No.' },
		);
		const more = await executeTool(
			'send_to',
			{ ref: 'checkout-api/main' },
			{ ...context.tools, now, utterance: 'No, use the table instead of the view.' },
		);

		expect(bare.ok).toBe(false);
		expect(more.ok).toBe(true);
	});

	it('the answer tool with the session named answers it; other words from elsewhere still go', async () => {
		const named = withHeldQuestion('line');
		const other = withHeldQuestion('line');

		await executeTool(
			'answer',
			{ ref: 'checkout-api/main', decision: 'yes', text: 'Cap it.' },
			{ ...named.tools, screen: null, utterance: 'checkout api main, yes, cap it' },
		);
		await executeTool(
			'send_to',
			{ ref: 'checkout-api/main', text: 'Also run the linter.' },
			{ ...other.tools, screen: null, utterance: 'also have it run the linter' },
		);

		expect(named.actions).toContainEqual(
			expect.objectContaining({ type: 'send', ref: 'checkout-api/main' }),
		);
		expect(other.actions).toContainEqual(
			expect.objectContaining({ type: 'send', text: 'also have it run the linter' }),
		);
	});

	it('naming the session answers it as usual', async () => {
		const { tools, actions } = withHeldQuestion('line');

		await executeTool(
			'send_to',
			{ ref: 'checkout-api/main', text: 'Yes, cap it.' },
			{ ...tools, screen: null, utterance: 'tell checkout api main yes, cap it' },
		);

		expect(actions).toContainEqual(
			expect.objectContaining({ type: 'send', ref: 'checkout-api/main' }),
		);
	});
});

describe('status from another screen', () => {
	const withHeldUpdate = () => {
		const context = createToolContext();
		const state = context.tools.getState();
		state.sessions['checkout-api/main'] = {
			...state.sessions['checkout-api/main']!,
			heldLine: {
				id: 'h1',
				at: 0,
				missed: 0,
				isAnnounced: false,
				kind: 'line',
				text: 'Tests pass; wiring the page.',
				isAsking: false,
			},
		};

		return context;
	};

	it('asked about by name → its latest update, and it counts as heard', async () => {
		const { tools, actions } = withHeldUpdate();
		const result = await executeTool(
			'read_state',
			{ ref: 'checkout-api/main' },
			{ ...tools, utterance: "how's checkout api main doing?" },
		);

		expect(result.content).toContain('Tests pass; wiring the page.');
		expect(actions).toEqual([{ type: 'held_line_heard', ref: 'checkout-api/main', id: 'h1' }]);
	});

	it('read for any other reason, or in the overview → nothing cleared, no update in the overview', async () => {
		const { tools, actions } = withHeldUpdate();
		const overview = await executeTool(
			'read_state',
			{ ref: null },
			{ ...tools, utterance: "what's waiting?" },
		);
		await executeTool(
			'read_state',
			{ ref: 'checkout-api/main' },
			{ ...tools, utterance: "what's waiting?" },
		);

		expect(String(overview.content)).not.toContain('latest_update');
		expect(actions).toEqual([]);
	});
});

describe('queued_message', () => {
	const withQueue = (lastSpoken: string | null) => {
		const context = createToolContext();
		const state = context.tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'running',
			queue: [
				{ id: 'q1', text: 'use proxy pair', at: 1 },
				{ id: 'q2', text: 'then the tests', at: 2 },
			],
		};
		state.lastSpokenSend = lastSpoken
			? { ref: 'store-front/main', id: lastSpoken, text: 'x', at: 1 }
			: null;

		return context;
	};

	const withOneQueued = (lastSpoken: string | null) => {
		const context = withQueue(lastSpoken);
		const state = context.tools.getState();
		const session = state.sessions['store-front/main']!;
		// Voice OS's own retry is not the developer's: it never makes "now" mean all of them.
		state.sessions['store-front/main'] = {
			...session,
			queue: [
				session.queue[0]!,
				{ id: 'r1', text: 'The user allows this once: retry "x" now.', at: 3, isRetry: true },
			],
		};

		return context;
	};

	it("the developer's last words when they wait there, else the newest; now or drop", async () => {
		const spoken = withOneQueued('q1');
		const newest = withQueue(null);

		await executeTool('queued_message', { ref: 'store-front/main', action: 'now' }, spoken.tools);
		await executeTool('queued_message', { ref: 'store-front/main', action: 'drop' }, newest.tools);

		expect(spoken.actions).toEqual([
			{ type: 'promote_queued', ref: 'store-front/main', queuedId: 'q1' },
		]);
		expect(newest.actions).toEqual([{ type: 'take_back', ref: 'store-front/main', id: 'q2' }]);
	});

	it('"send both now" with two of theirs waiting, the carrier second → all of them, as one, and the count said', async () => {
		const context = withQueue('q2');
		const result = await executeTool(
			'queued_message',
			{ ref: 'store-front/main', action: 'now' },
			context.tools,
		);

		expect(context.actions).toEqual([{ type: 'promote_all_queued', ref: 'store-front/main' }]);
		expect(result).toMatchObject({
			ok: true,
			content:
				'store-front/main stops its current work and takes all 2 queued messages now, as one',
		});
	});

	it('last words said to another session → the newest queued; already delivered here → nothing sent now', async () => {
		const gone = withQueue('q-gone');
		const elsewhere = withOneQueued(null);
		elsewhere.tools.getState().lastSpokenSend = {
			ref: 'checkout-api/main',
			id: 'q1',
			text: 'x',
			at: 1,
		};

		expect(
			(await executeTool('queued_message', { ref: 'store-front/main', action: 'now' }, gone.tools))
				.ok,
		).toBe(false);
		await executeTool(
			'queued_message',
			{ ref: 'store-front/main', action: 'now' },
			elsewhere.tools,
		);

		expect([...gone.actions, ...elsewhere.actions]).toEqual([
			{ type: 'promote_queued', ref: 'store-front/main', queuedId: 'q1' },
		]);
	});

	it('take back: a side question still asking, a held switch, or words already being worked on', async () => {
		const withCarrier = (patch: (state: State) => void) => {
			const context = createToolContext();
			const state = context.tools.getState();
			state.sessions['store-front/main'] = {
				...state.sessions['store-front/main']!,
				status: 'running',
				currentSendId: 'running-1',
				stream: [
					{
						id: 'aside-1',
						at: 1,
						kind: 'aside',
						question: 'which file?',
						answer: null,
						status: 'asking',
					},
				],
			};
			patch(state);

			return context;
		};

		const aside = withCarrier((state) => {
			state.lastSpokenSend = { ref: 'store-front/main', id: 'aside-1', text: 'x', at: 1 };
		});
		const held = withCarrier((state) => {
			state.asks = [
				{
					id: 'held-1',
					ref: 'store-front/main',
					at: 1,
					kind: 'redirect',
					text: 'use proxy pair',
					target: null,
				},
			];
			state.lastSpokenSend = { ref: 'store-front/main', id: 'held-1', text: 'x', at: 1 };
		});
		const running = withCarrier((state) => {
			state.lastSpokenSend = { ref: 'store-front/main', id: 'running-1', text: 'x', at: 1 };
		});
		const drop = { ref: 'store-front/main', action: 'drop' };

		await executeTool('queued_message', drop, aside.tools);
		await executeTool('queued_message', drop, held.tools);

		expect([...aside.actions, ...held.actions]).toEqual([
			{ type: 'take_back', ref: 'store-front/main', id: 'aside-1' },
			{ type: 'take_back', ref: 'store-front/main', id: 'held-1' },
		]);
		expect((await executeTool('queued_message', drop, running.tools)).ok).toBe(true);
		expect(running.actions).toEqual([{ type: 'send', ref: 'store-front/main', text: TAKEN_BACK }]);
	});

	it('take back uses the last words as they were when said: a send earlier in the turn does not move them', async () => {
		const context = withQueue(null);
		const state = context.tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			stream: [
				{
					id: 'aside-1',
					at: 1,
					kind: 'aside',
					question: 'wrong one',
					answer: null,
					status: 'asking',
				},
			],
		};
		// Moved by the send_to that ran first in this turn; the snapshot still names the aside.
		state.lastSpokenSend = { ref: 'checkout-api/main', id: 'new', text: 'x', at: 2 };
		const tools = {
			...context.tools,
			lastSpokenSend: { ref: 'store-front/main', id: 'aside-1', text: 'wrong one', at: 1 },
		};

		await executeTool('queued_message', { ref: 'store-front/main', action: 'drop' }, tools);

		expect(context.actions).toEqual([
			{ type: 'take_back', ref: 'store-front/main', id: 'aside-1' },
		]);
	});

	it('last words being worked on (even blocked) or already sent → it is told they were taken back; nothing else is taken', async () => {
		const blocked = withQueue('running-1');
		blocked.tools.getState().sessions['store-front/main'] = {
			...blocked.tools.getState().sessions['store-front/main']!,
			status: 'blocked',
			currentSendId: 'running-1',
		};
		const finished = withQueue('done-1');
		const drop = { ref: 'store-front/main', action: 'drop' };

		await executeTool('queued_message', drop, blocked.tools);
		await executeTool('queued_message', drop, finished.tools);

		expect([...blocked.actions, ...finished.actions]).toEqual([
			{ type: 'send', ref: 'store-front/main', text: TAKEN_BACK },
			{ type: 'send', ref: 'store-front/main', text: TAKEN_BACK },
		]);
	});

	it('"that was for checkout" while its words are being worked on → it is stopped and told; words that only correct it go to it', async () => {
		const running = () => {
			const context = withQueue('running-1');
			context.tools.getState().sessions['store-front/main'] = {
				...context.tools.getState().sessions['store-front/main']!,
				status: 'running',
				queue: [],
				currentSendId: 'running-1',
			};

			return context;
		};

		const drop = { ref: 'store-front/main', action: 'drop' };
		const misrouted = running();
		const corrected = running();

		await executeTool('queued_message', drop, {
			...misrouted.tools,
			utterance: 'Sorry, that was for checkout api main.',
		});
		await executeTool('queued_message', drop, {
			...corrected.tools,
			utterance: 'No, remove that, use the other file instead.',
		});

		expect(misrouted.actions).toEqual([
			{ type: 'interrupt', ref: 'store-front/main', isCorrection: true },
			{ type: 'send', ref: 'store-front/main', text: TAKEN_BACK },
		]);
		expect(corrected.actions).toEqual([
			expect.objectContaining({
				type: 'send',
				text: 'No, remove that, use the other file instead.',
			}),
		]);
	});

	it('delivered words that now wait on a permission → nothing sent (it would answer it); the kernel answers it no', async () => {
		const context = withQueue('running-1');
		const state = context.tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'blocked',
			currentSendId: 'running-1',
		};
		state.asks = [
			{
				id: 'p1',
				ref: 'store-front/main',
				at: 1,
				kind: 'permission',
				toolName: 'Bash',
				summary: 'run the migration',
				input: {},
				suggestions: [],
			},
		];
		const result = await executeTool(
			'queued_message',
			{ ref: 'store-front/main', action: 'drop' },
			context.tools,
		);

		expect(result.ok).toBe(false);
		expect(String(result.content)).toContain('answer it no');
		expect(context.actions).toEqual([]);
	});

	describe('take back of words already delivered (note 86)', () => {
		const CORRECTION =
			"Oh, no, no, no. Let's remove that. I don't want that. What I meant by Soniox is, like, to add a Soniox tags like the TTS tags.";
		const drop = { ref: 'store-front/main', action: 'drop' };

		const delivered = () => {
			const context = createToolContext();
			context.tools.getState().lastSpokenSend = {
				ref: 'store-front/main',
				id: 'done-1',
				text: 'x',
				at: 1,
			};

			return context;
		};

		it('bare take-back words → it is told, neutrally, that the developer took them back', async () => {
			for (const utterance of [
				'Never mind.',
				'Scratch that.',
				'Oh, take that back.',
				'Forget it',
			]) {
				const { tools, actions } = delivered();

				expect((await executeTool('queued_message', drop, { ...tools, utterance })).ok).toBe(true);
				expect(actions).toEqual([{ type: 'send', ref: 'store-front/main', text: TAKEN_BACK }]);
			}

			expect(TAKEN_BACK).not.toContain('wrong session');
		});

		it('a correction → its words go to the session as said, nothing is taken back', async () => {
			const { tools, actions } = delivered();
			const result = await executeTool('queued_message', drop, {
				...tools,
				utterance: CORRECTION,
				forwardTo: 'store-front/main',
			});

			expect(result).toMatchObject({
				ok: true,
				content: expect.stringContaining('went to it as said instead'),
				recordAs: { name: 'forward', input: { text: CORRECTION } },
			});
			expect(actions).toEqual([
				{ type: 'send', ref: 'store-front/main', text: CORRECTION, ack: INSTRUCTION_ACK },
			]);
		});

		it('a correction whose words already went there this turn → not sent twice', async () => {
			const { tools, actions } = delivered();
			const result = await executeTool('queued_message', drop, {
				...tools,
				utterance: CORRECTION,
				sentTo: new Set(['store-front/main']),
			});

			expect(result.ok).toBe(true);
			expect(actions).toEqual([]);
		});

		it('words still queued → taken back, whatever was said', async () => {
			const queued = withQueue(null);

			await executeTool('queued_message', drop, { ...queued.tools, utterance: CORRECTION });

			expect(queued.actions).toEqual([{ type: 'take_back', ref: 'store-front/main', id: 'q2' }]);
		});

		it('no utterance (typed or replayed) → taken back', async () => {
			const { tools, actions } = delivered();

			await executeTool('queued_message', drop, tools);

			expect(actions).toEqual([{ type: 'send', ref: 'store-front/main', text: TAKEN_BACK }]);
		});
	});

	it('nothing queued, or an unknown action → fails, nothing dispatched', async () => {
		const { tools, actions } = createToolContext();
		const queued = withQueue(null);

		expect(
			(await executeTool('queued_message', { ref: 'store-front/main', action: 'now' }, tools)).ok,
		).toBe(false);
		expect(
			(
				await executeTool(
					'queued_message',
					{ ref: 'store-front/main', action: 'later' },
					queued.tools,
				)
			).ok,
		).toBe(false);
		expect(
			(await executeTool('queued_message', { ref: 'store-front/main', action: 'drop' }, tools)).ok,
		).toBe(false);
		expect(actions).toEqual([]);
		expect(queued.actions).toEqual([]);
	});
});

describe('describeSession', () => {
	const createServer = (
		name: string,
		state: 'running' | 'died' | 'not listening' | 'starting',
		detail: string | null = null,
	) => ({ name, port: 3000, url: null, state, detail });

	it('stopped by a crash → why, first line only; a clean stop → nothing', () => {
		const { tools } = createToolContext();
		const state = tools.getState();
		state.sessions['checkout-api/main'] = {
			...state.sessions['checkout-api/main']!,
			error: 'Claude Code native binary not found at claude\n  at spawn (worker.js:1)',
		};

		expect(
			describeSession({ state, ref: 'checkout-api/main', isDetailed: false, now: 0 }).crashed,
		).toBe('Claude Code native binary not found at claude');
		expect(
			describeSession({ state, ref: 'store-front/main', isDetailed: false, now: 0 }).crashed,
		).toBeUndefined();
	});

	it('in detail, the last reply in full: "what did it say" reads it back, not a clipped line', () => {
		const { tools } = createToolContext();
		const state = tools.getState();
		const longReply = `The flake came from a shared fixture. ${'More detail. '.repeat(40)}`;
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			stream: [
				{ id: 'u1', at: 1, kind: 'user', text: 'Why is the test flaky?' },
				{ id: 't1', at: 2, kind: 'text', text: longReply },
				{ id: 's1', at: 3, kind: 'tool', name: 'Bash', summary: 'bun test' },
			],
		};

		const detailed = describeSession({ state, ref: 'store-front/main', isDetailed: true, now: 0 });
		const brief = describeSession({ state, ref: 'store-front/main', isDetailed: false, now: 0 });

		expect(detailed.last_reply).toBe(longReply);
		expect(String((detailed.recent as string[])[1]).length).toBeLessThan(longReply.length);
		expect(brief.last_reply).toBeUndefined();
	});

	it('compacting and background sub-agents are said; neither → neither key', () => {
		const { tools } = createToolContext();
		const state = tools.getState();
		const idle = describeSession({ state, ref: 'store-front/main', isDetailed: false, now: 0 });
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			compactingSince: 1_000,
			subagents: [
				{
					taskId: 't1',
					agentType: null,
					description: 'research',
					startedAt: 0,
					step: null,
					isBackground: true,
				},
			],
		};
		const busy = describeSession({
			state,
			ref: 'store-front/main',
			isDetailed: false,
			now: 13_000,
		});

		expect(idle.compacting_for).toBeUndefined();
		expect(idle.background_agents).toBeUndefined();
		expect(busy.background_agents).toBe(1);
		expect(busy.compacting_for).toBe(formatAge(12_000));
	});

	it('several questions pending → the open one with its options, and how many are left', () => {
		const ask: PendingAsk = {
			id: 'q3',
			ref: 'store-front/main',
			at: 1,
			kind: 'question',
			input: {},
			questions: ['Which table?', 'Which index?', 'Which view?'].map((question) => ({
				question,
				multiSelect: false,
				options: [{ label: `${question} A` }],
			})),
			answers: { 'Which table?': 'New' },
		};
		const { tools } = createToolContext({ asks: [ask] });
		const view = describeSession({
			state: tools.getState(),
			ref: 'store-front/main',
			isDetailed: false,
			now: 0,
		});

		expect(view.pending).toEqual({
			kind: 'question',
			question: 'Which index?',
			options: ['Which index? A'],
			questions_left: 2,
		});
	});

	it('one question left → no count', () => {
		const ask: PendingAsk = {
			id: 'q6',
			ref: 'store-front/main',
			at: 1,
			kind: 'question',
			input: {},
			questions: ['Which table?', 'Which index?'].map((question) => ({
				question,
				multiSelect: false,
				options: [],
			})),
			answers: { 'Which table?': 'New' },
		};
		const { tools } = createToolContext({ asks: [ask] });

		expect(
			describeSession({
				state: tools.getState(),
				ref: 'store-front/main',
				isDetailed: false,
				now: 0,
			}).pending,
		).toEqual({ kind: 'question', question: 'Which index?', options: [] });
	});

	it('a reply longer than 2000 characters is cut; a session that has not replied has none', () => {
		const { tools } = createToolContext();
		const state = tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			stream: [{ id: 't1', at: 2, kind: 'text', text: 'x'.repeat(3000) }],
		};

		const lastReply = describeSession({
			state,
			ref: 'store-front/main',
			isDetailed: true,
			now: 0,
		}).last_reply;

		expect(String(lastReply)).toHaveLength(2001);
		expect(
			describeSession({ state, ref: 'store-front/wrk1', isDetailed: true, now: 0 }).last_reply,
		).toBeUndefined();
	});

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
			describeToolCall({ name: 'deactivate', input: { ref: 'store-front/main' }, ok: false }),
		).toBe('deactivate store-front/main (failed)');
		expect(describeToolCall({ name: 'hands_free', input: { mode: 'push' }, ok: true })).toBe(
			'hands_free push',
		);
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

	it('the developer in the Discord voice channel → every send says they cannot see the page', async () => {
		const context = createToolContext({
			discord: {
				isConnected: true,
				isHearing: true,
				isOwnerIn: true,
				channelName: 'Voice OS',
				mode: 'hands-free',
			},
		});

		await executeTool('send_to', { ref: 'store-front/wrk1', text: 'run the tests' }, context.tools);
		await executeTool(
			'send_to',
			{ ref: 'store-front/wrk1', text: 'and the linter' },
			context.tools,
		);

		expect(context.actions.map((action) => (action.type === 'send' ? action.note : null))).toEqual([
			expect.stringContaining('Discord voice channel'),
			expect.stringContaining('Discord voice channel'),
		]);
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

		expect(actions[0]).toEqual({
			type: 'send',
			ref: 'checkout-api/main',
			text: 'Run the tests.',
			ack: INSTRUCTION_ACK,
		});
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
		store.dispatch({ type: 'active_loaded', refs: ['store-front/main', 'checkout-api/main'] });
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
			judge: englishJudge,
			notes: createNullNotes(),
			setListenMode: () => 'changed' as const,
			openUrl: () => true,
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

		tools.dispatch({ type: 'activate', ref: 'store-front/main' });
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

describe('what Voice OS just did goes with "check this debug note" (note 84)', () => {
	const noteSaved: VoiceEntry = {
		utterance: 'Add a debug note that only the request was forwarded.',
		did: ['debug_note "Only the request was forwarded."'],
		reply: 'Debug note saved.',
		at: 0,
	};
	const SAID = 'Also tell the session to check this debug note.';

	it("forwarded to an idle session → the note carries the debug note's words", async () => {
		const { tools, actions } = createToolContext({ voiceLog: { 'store-front/main': [noteSaved] } });

		await executeTool(
			'forward',
			{ about_last_action: true, text: 'Check this debug note.' },
			{ ...tools, forwardTo: 'store-front/main', screen: 'store-front/main', utterance: SAID },
		);

		expect(actions).toEqual([
			expect.objectContaining({
				type: 'send',
				text: SAID,
				note: expect.stringContaining(
					`the developer told Voice OS: "${noteSaved.utterance}", and Voice OS saved it as a debug note.`,
				),
			}),
		]);
	});

	it('asked aside of a working session → the aside carries it too', async () => {
		const base = createToolContext();
		const session = base.tools.getState().sessions['store-front/main']!;
		const { tools, actions } = createToolContext({
			voiceLog: { 'store-front/main': [noteSaved] },
			sessions: {
				...base.tools.getState().sessions,
				'store-front/main': { ...session, status: 'running' },
			},
		});

		await executeTool(
			'forward',
			{ about_last_action: true, text: 'What do you make of this debug note?', kind: 'question' },
			{
				...tools,
				forwardTo: 'store-front/main',
				screen: 'store-front/main',
				utterance: 'What do you make of this debug note?',
			},
		);

		expect(actions).toEqual([
			expect.objectContaining({
				aside: true,
				note: expect.stringContaining(noteSaved.utterance),
			}),
		]);
	});

	it('through the real reducer → the stream shows only the words, not the note', async () => {
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{
					ref: 'store-front/main',
					label: 'store-front/main',
					branch: '',
					cwd: '/w',
					dirs: [],
					isPinned: false,
				},
			],
		});
		store.dispatch({ type: 'activate', ref: 'store-front/main' });
		store.dispatch({ type: 'session_started', ref: 'store-front/main' } as unknown as Action);
		store.dispatch({ type: 'voice_logged', screen: 'store-front/main', entry: noteSaved });
		const sent: Action[] = [];
		const { tools } = createToolContext();

		await executeTool(
			'forward',
			{ about_last_action: true, text: 'Check this debug note.' },
			{
				...tools,
				getState: () => store.state,
				dispatch: (action) => {
					sent.push(action);
					store.dispatch(action);
				},
				forwardTo: 'store-front/main',
				screen: 'store-front/main',
				utterance: SAID,
			},
		);

		const user = store.state.sessions['store-front/main']!.stream.findLast(
			(item) => item.kind === 'user',
		);

		expect(sent[0]).toMatchObject({ note: expect.stringContaining(noteSaved.utterance) });
		expect(user).toMatchObject({ text: SAID });
	});
});

describe('deactivate guard: "this session"', () => {
	it('names the session on screen', async () => {
		const { tools, actions } = createToolContext();

		await executeTool(
			'deactivate',
			{ ref: 'store-front/main' },
			{ ...tools, utterance: 'And end this session.', screen: 'store-front/main' },
		);

		expect(actions).toEqual([{ type: 'deactivate', ref: 'store-front/main' }]);
	});

	it('is not another session', async () => {
		const { tools, actions } = createToolContext();

		const result = await executeTool(
			'deactivate',
			{ ref: 'store-front/wrk1' },
			{ ...tools, utterance: 'end this session', screen: 'store-front/main' },
		);

		expect(result.ok).toBe(false);
		expect(actions).toEqual([]);
	});

	it('a session named beats "this one"', async () => {
		const { tools, actions } = createToolContext();

		const wrongResult = await executeTool(
			'deactivate',
			{ ref: 'store-front/main' },
			{ ...tools, utterance: 'Stop the checkout one, not this one.', screen: 'store-front/main' },
		);

		expect(wrongResult.ok).toBe(false);

		await executeTool(
			'deactivate',
			{ ref: 'checkout-api/main' },
			{ ...tools, utterance: 'Stop the checkout one, not this one.', screen: 'store-front/main' },
		);

		expect(actions).toEqual([{ type: 'deactivate', ref: 'checkout-api/main' }]);
	});

	it('on Mission Control there is no "this session"', async () => {
		const { tools, actions } = createToolContext();

		const result = await executeTool(
			'deactivate',
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
			{ ...tools, screen: 'store-front/main', forwardTo: 'store-front/main', isSpoken: true },
		);
		await executeTool(
			'send_to',
			{ ref: 'store-front/wrk1', text: 'Run the tests.' },
			{ ...tools, isSpoken: false },
		);

		expect(actions).toEqual([
			{
				type: 'send',
				ref: 'store-front/main',
				text: 'Run the tests.',
				ack: INSTRUCTION_ACK,
				isSpoken: true,
				saidOn: 'store-front/main',
			},
			{ type: 'send', ref: 'store-front/wrk1', text: 'Run the tests.', ack: INSTRUCTION_ACK },
		]);
	});

	it('a spoken question aside to a working session → marked with the screen it was said on', async () => {
		const { tools, actions } = createToolContext();
		const state = tools.getState();
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'running',
		};

		await executeTool(
			'forward',
			{ kind: 'question' },
			{
				...tools,
				screen: 'store-front/main',
				forwardTo: 'store-front/main',
				isSpoken: true,
				utterance: 'Which file?',
			},
		);

		expect(actions[0]).toMatchObject({
			type: 'send',
			ref: 'store-front/main',
			aside: true,
			isSpoken: true,
			saidOn: 'store-front/main',
		});
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

	it('several questions: the words answer the open one; answered on screen meanwhile → refused, never filed under the next', async () => {
		const two: PendingAsk = {
			id: 'q2',
			ref: 'store-front/main',
			at: 1,
			kind: 'question',
			input: {},
			questions: [
				{ question: 'Which table?', multiSelect: false, options: [{ label: 'New' }] },
				{ question: 'Which index?', multiSelect: false, options: [{ label: 'Partial' }] },
			],
		};
		const heard = createToolContext({ asks: [two] });

		expect(
			(
				await executeTool(
					'answer',
					{ ref: 'store-front/main', decision: 'choose', text: 'New' },
					{ ...heard.tools, asks: [two] },
				)
			).ok,
		).toBe(true);
		expect(heard.actions).toEqual([
			{ type: 'answer_question', askId: 'q2', answers: { 'Which table?': 'New' }, isSpoken: true },
		]);

		const clicked = { ...two, answers: { 'Which table?': 'New' } };
		const late = createToolContext({ asks: [clicked] });
		const result = await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'choose', text: 'New' },
			{ ...late.tools, asks: [two] },
		);

		expect(result.ok).toBe(false);
		expect(result.content).toContain('already has an answer');
		expect(late.actions).toEqual([]);
	});

	it('two answers in one breath → the first fills the open question; the second is not filed under the next', async () => {
		const two: PendingAsk = {
			id: 'q4',
			ref: 'store-front/main',
			at: 1,
			kind: 'question',
			input: {},
			questions: [
				{ question: 'Which table?', multiSelect: false, options: [{ label: 'New' }] },
				{ question: 'Which index?', multiSelect: false, options: [{ label: 'Partial' }] },
			],
		};
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{
					ref: 'store-front/main',
					label: 'store-front/main',
					branch: '',
					cwd: '/w',
					dirs: [],
					isPinned: false,
				},
			],
		});
		store.dispatch({ type: 'active_loaded', refs: ['store-front/main'] });
		store.dispatch({ type: 'ask_opened', ask: two });
		const { tools } = createToolContext();
		const context = {
			...tools,
			getState: () => store.state,
			dispatch: (action: Action) => store.dispatch(action),
			asks: [two],
		};

		const first = await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'choose', text: 'New' },
			context,
		);
		const second = await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'choose', text: 'Partial' },
			context,
		);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
		expect(second.content).toContain('do not read the next question');
		expect(store.state.asks[0]).toMatchObject({ answers: { 'Which table?': 'New' } });
	});

	it('words forwarded to a question answered on the page meanwhile → not sent, nothing filed', async () => {
		const two: PendingAsk = {
			id: 'q5',
			ref: 'store-front/main',
			at: 1,
			kind: 'question',
			input: {},
			questions: [
				{ question: 'Which table?', multiSelect: false, options: [] },
				{ question: 'Which index?', multiSelect: false, options: [] },
			],
		};
		const clicked = { ...two, answers: { 'Which table?': 'New' } };
		const { tools, actions } = createToolContext({ asks: [clicked] });
		const result = await executeTool(
			'forward',
			{ text: 'Use the orders table.', kind: 'instruction' },
			{ ...tools, forwardTo: 'store-front/main', asks: [two] },
		);

		expect(result.ok).toBe(false);
		expect(result.content).toContain('already has an answer');
		expect(actions).toEqual([]);

		// The question the kernel saw open is still the open one: the words go through.
		const same = createToolContext({ asks: [clicked] });
		const sent = await executeTool(
			'forward',
			{ text: 'Use the orders table.', kind: 'instruction' },
			{ ...same.tools, forwardTo: 'store-front/main', asks: [clicked] },
		);

		expect(sent.ok).toBe(true);
		expect(same.actions).toContainEqual(
			expect.objectContaining({ type: 'send', text: 'Use the orders table.' }),
		);
	});

	it('a yes to a permission from words that say no yes ("also run the linter") → refused, nothing approved', async () => {
		const { tools, actions } = createToolContext({ asks: [permission] });

		const result = await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'yes', text: 'Run the linter afterwards.' },
			{ ...tools, asks: [permission], utterance: 'Also run the linter.' },
		);

		expect(result).toMatchObject({
			ok: false,
			content: expect.stringContaining('did not say yes'),
		});
		expect(actions).toEqual([]);
	});

	it('a no to a permission needs no yes; a real yes approves', async () => {
		const { tools, actions } = createToolContext({ asks: [permission] });

		expect(
			(
				await executeTool(
					'answer',
					{ ref: 'store-front/main', decision: 'no', text: 'Use a new branch.' },
					{ ...tools, asks: [permission], utterance: 'No, use a new branch.' },
				)
			).ok,
		).toBe(true);
		expect(
			(
				await executeTool(
					'answer',
					{ ref: 'store-front/main', decision: 'yes', text: '' },
					{ ...tools, asks: [permission], utterance: 'Yeah, go ahead.' },
				)
			).ok,
		).toBe(true);
		expect(actions.map((action) => action.type)).toEqual([
			'answer_permission',
			'answer_permission',
		]);
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

	it('a bare yes or no sent as words to a permission or plan → refused: it is an answer', async () => {
		for (const ask of [permission, plan]) {
			for (const text of ['yes', 'Go ahead.', 'no', "Don't."]) {
				const { tools, actions } = createToolContext({ asks: [ask] });
				const result = await executeTool(
					'forward',
					{ text },
					{ ...tools, forwardTo: 'store-front/main' },
				);

				expect(result.content).toContain('use the answer tool');
				expect(actions).toEqual([]);
			}
		}
	});

	it('anything else said while a permission, plan or question waits → it goes through: the developer moved on', async () => {
		for (const ask of [permission, plan, question]) {
			const { tools, actions } = createToolContext({ asks: [ask] });

			expect(
				(
					await executeTool(
						'forward',
						{ text: "Let's get back to the router work instead." },
						{ ...tools, forwardTo: 'store-front/main' },
					)
				).ok,
			).toBe(true);
			expect(
				(
					await executeTool(
						'send_to',
						{ ref: 'store-front/main', text: 'Also run the linter.' },
						tools,
					)
				).ok,
			).toBe(true);
			expect(actions).toHaveLength(2);
		}
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

	it('mute runs only on a whole mute command (note 83); with no words it mutes', async () => {
		const note83 =
			"Okay, can you can you paste this to Voi. To crew main, like the debug notes, and just the notes? Uh, and also so when I select remote, which doesn't have anything, I don't want it to connect, like, uh, I don't want it to tell me that nothing is waiting for me. Just be silent, okay? Only say things if there's actually anything to do. But yeah, ask crew main to check debug notes and notes, um, and give me a list, and I'll decide on what to do, okay?";
		const { tools } = createToolContext();

		const mutes = async (utterance: string | undefined) => {
			let muted = 0;
			const result = await executeTool('mute', {}, { ...tools, utterance, mute: () => muted++ });

			return result.ok && muted === 1;
		};

		for (const said of [
			'mute',
			'Be quiet.',
			'Shut up!',
			'Be silent.',
			'Voice OS, stop talking',
			'Mute, Voice OS.',
			'Shut up Voice OS',
			'Quiet please, VoiceOS.',
		]) {
			expect(await mutes(said)).toBe(true);
		}

		for (const said of ['Make the tests quiet.', 'Mute Voice OS for the tests.', note83]) {
			expect(await mutes(said)).toBe(false);
		}

		expect(await mutes(undefined)).toBe(true);
		expect((await executeTool('mute', {}, { ...tools, utterance: note83 })).content).toBe(
			'not a mute request; do nothing more',
		);
	});

	it("debug_note keeps what the developer said beside the kernel's text", async () => {
		const notes: DebugNoteWords[] = [];
		const { tools } = createToolContext();

		await executeTool(
			'debug_note',
			{ text: 'it dropped the skill name' },
			{
				...tools,
				utterance: 'Add a debug note: it dropped proxy brainstorm.',
				saveDebugNote: (words) => notes.push(words),
				judge: englishJudge,
			},
		);

		expect(notes).toEqual([
			{ text: 'it dropped the skill name', said: 'Add a debug note: it dropped proxy brainstorm.' },
		]);
	});

	it('debug_note from typed words with no utterance → said is null, never made up', async () => {
		const notes: DebugNoteWords[] = [];
		const { tools } = createToolContext();

		await executeTool(
			'debug_note',
			{ text: 'it re-asked' },
			{ ...tools, saveDebugNote: (words) => notes.push(words) },
		);

		expect(notes).toEqual([{ text: 'it re-asked', said: null }]);
	});

	it("debug_note hands the words to Voice OS's note-taker and dispatches nothing; an empty one is refused", async () => {
		const notes: string[] = [];
		const { tools, actions } = createToolContext();

		expect(
			await executeTool(
				'debug_note',
				{ text: ' it re-asked the question ' },
				{ ...tools, saveDebugNote: ({ text }) => notes.push(text) },
			),
		).toMatchObject({ ok: true });
		expect(
			(
				await executeTool(
					'debug_note',
					{ text: '' },
					{ ...tools, saveDebugNote: ({ text }) => notes.push(text) },
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

	it('every new tool changes something, is remembered, and is silent unless it has a fixed reply', () => {
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

		// Their fixed reply is what is said, so neither is silent; neither takes the developer's words.
		for (const name of ['deactivate', 'rename_session'] as const) {
			expect(MUTATING_TOOLS).toContain(name);
			expect(isSilentCall(name, {})).toBe(false);
			expect(carriesWords(name)).toBe(false);
		}

		// Voice OS says "Activated X. Switch there?" itself; the words beside it are not its.
		expect(MUTATING_TOOLS).toContain('activate');
		expect(isSilentCall('activate', {})).toBe(true);
		expect(carriesWords('activate')).toBe(false);

		// Read-only: the kernel says what it found.
		expect(MUTATING_TOOLS).not.toContain('list_sessions');
		expect(isSilentCall('list_sessions', {})).toBe(false);

		expect(describeToolCall({ name: 'activate', input: { name: 'x/main' }, ok: true })).toBe(
			'activate x/main',
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

describe('side answers', () => {
	const running = () => {
		const base = createToolContext();
		const session = base.tools.getState().sessions['store-front/main']!;

		return createToolContext({
			sessions: {
				...base.tools.getState().sessions,
				'store-front/main': { ...session, status: 'running' },
			},
		});
	};

	it('a question to a working session → asked aside, and the voice log says so', async () => {
		const { tools, actions } = running();
		const result = await executeTool(
			'forward',
			{ text: 'Which file did you change?', kind: 'question' },
			{ ...tools, forwardTo: 'store-front/main', utterance: 'which file did you change?' },
		);

		expect(result).toMatchObject({ ok: true, note: 'aside' });
		expect(actions).toEqual([
			{ type: 'send', ref: 'store-front/main', text: 'Which file did you change?', aside: true },
		]);
		expect(
			describeToolCall({
				name: 'forward',
				input: { text: 'Which file?' },
				ok: true,
				note: 'aside',
			}),
		).toBe('forward "Which file?" (aside)');
	});

	it('an instruction to a working session → sent as always', async () => {
		const { tools, actions } = running();

		await executeTool(
			'forward',
			{ text: 'Also run the linter.', kind: 'instruction' },
			{ ...tools, forwardTo: 'store-front/main', utterance: 'also run the linter' },
		);

		expect(actions).toEqual([
			{ type: 'send', ref: 'store-front/main', text: 'Also run the linter.', ack: INSTRUCTION_ACK },
		]);
	});

	it('deliver aside ("by the way", read by the kernel) → an instruction still goes aside', async () => {
		const { tools, actions } = running();

		await executeTool(
			'send_to',
			{
				ref: 'store-front/main',
				text: 'Run the linter too.',
				kind: 'instruction',
				deliver: 'aside',
			},
			{ ...tools, utterance: 'by the way, have store front run the linter too' },
		);

		expect(actions[0]).toMatchObject({ aside: true });
	});

	it('deliver now to a working session → sent with isNow, and the result says it stops for them', async () => {
		const { tools, actions } = running();
		const result = await executeTool(
			'forward',
			{ text: 'Why is the build red?', kind: 'question', deliver: 'now' },
			{
				...tools,
				forwardTo: 'store-front/main',
				utterance: 'ask it right now, why is the build red?',
			},
		);

		expect(actions).toEqual([
			{
				type: 'send',
				ref: 'store-front/main',
				text: 'ask it right now, why is the build red?',
				ack: { kind: 'question' },
				isNow: true,
			},
		]);
		expect(result).toMatchObject({
			ok: true,
			content: 'sent to store-front/main: it stops its current work and takes these words now',
		});
	});

	it('a question to an idle session → sent, not aside', async () => {
		const { tools, actions } = createToolContext();

		await executeTool(
			'forward',
			{ text: 'Which file?', kind: 'question' },
			{ ...tools, forwardTo: 'store-front/main', utterance: 'which file?' },
		);

		expect(actions[0]).not.toHaveProperty('aside');
	});
});

describe('a held /clear', () => {
	const held: PendingAsk = {
		id: 'c1',
		ref: 'store-front/main',
		at: 0,
		kind: 'command',
		command: 'clear',
		text: '/clear',
	};

	it('words for the session while it waits → they go through (the reducer cancels the /clear)', async () => {
		const { tools, actions } = createToolContext({ asks: [held] });
		const result = await executeTool(
			'forward',
			{ text: 'Run the tests.', kind: 'instruction' },
			{ ...tools, forwardTo: 'store-front/main' },
		);

		expect(result.ok).toBe(true);
		expect(actions).toEqual([
			{ type: 'send', ref: 'store-front/main', text: 'Run the tests.', ack: INSTRUCTION_ACK },
		]);
	});

	it('a bare "yes" forwarded as words → refused: it answers the /clear', async () => {
		const { tools, actions } = createToolContext({ asks: [held] });

		expect(
			(await executeTool('forward', { text: 'Yes.' }, { ...tools, forwardTo: 'store-front/main' }))
				.ok,
		).toBe(false);
		expect(actions).toEqual([]);
	});

	it('"yes" → approved', async () => {
		const { tools, actions } = createToolContext({ asks: [held] });

		await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'yes', text: '' },
			{ ...tools, asks: [held], utterance: 'yes' },
		);

		expect(actions).toEqual([{ type: 'answer_command', askId: 'c1', isApproved: true }]);
	});

	it('"don\'t do it" taken as yes by the model → not approved', async () => {
		const { tools, actions } = createToolContext({ asks: [held] });
		const result = await executeTool(
			'answer',
			{ ref: 'store-front/main', decision: 'yes', text: '' },
			{ ...tools, asks: [held], utterance: "don't do it" },
		);

		expect(result.ok).toBe(false);
		expect(actions).toEqual([]);
	});
});

describe('hands_free', () => {
	const withSwitch = (result: 'changed' | 'already' | 'no_tab' = 'changed') => {
		const { tools } = createToolContext();
		const switched: ListenMode[] = [];

		return {
			switched,
			tools: {
				...tools,
				setListenMode: (mode: ListenMode) => {
					switched.push(mode);

					return result;
				},
			},
		};
	};

	it.each([
		['turn off hands-free', 'push'],
		['hands free off', 'push'],
		['stop listening', 'push'],
		['switch to push to talk', 'push'],
		['turn handsfree on', 'hands-free'],
		['start listening', 'hands-free'],
		['enable hands-free', 'hands-free'],
		['switch to on demand', 'on-demand'],
		['on demand mode please', 'on-demand'],
		['listen for Voice OS', 'on-demand'],
		['use the wake word', 'on-demand'],
		['stop listening for Voice OS', 'push'],
		['turn off on demand mode', 'push'],
		['switch to hands-free', 'hands-free'],
		['go hands-free', 'hands-free'],
	] as [string, ListenMode][])(
		'%p → switched to %p, whatever the model said',
		async (utterance, mode) => {
			const { tools, switched } = withSwitch();
			const other = mode === 'push' ? 'hands-free' : 'push';
			const result = await executeTool('hands_free', { mode: other }, { ...tools, utterance });

			expect(result.ok).toBe(true);
			expect(switched).toEqual([mode]);
		},
	);

	it("without the developer's words, the model's mode is taken", async () => {
		const { tools, switched } = withSwitch();

		expect((await executeTool('hands_free', { mode: 'on-demand' }, tools)).ok).toBe(true);
		expect(switched).toEqual(['on-demand']);
	});

	it.each([
		'stop',
		'wait',
		'cancel',
		'listen, check the logs',
		'hands-free',
		'scale the workers on demand',
	])('%p → not switched', async (utterance) => {
		const { tools, switched } = withSwitch();

		expect((await executeTool('hands_free', { mode: 'push' }, { ...tools, utterance })).ok).toBe(
			false,
		);
		expect(switched).toEqual([]);
	});

	it('no tab to switch → fails honestly', async () => {
		const { tools } = withSwitch('no_tab');

		expect(
			(await executeTool('hands_free', { mode: 'push' }, { ...tools, utterance: 'stop listening' }))
				.ok,
		).toBe(false);
	});

	it.each(["stop, it's listening on the wrong port", 'wait, the server is listening on 3000'])(
		'%p → still an interrupt',
		async (utterance) => {
			const base = createToolContext();
			const session = base.tools.getState().sessions['store-front/main']!;
			const { tools, actions } = createToolContext({
				sessions: {
					...base.tools.getState().sessions,
					'store-front/main': { ...session, status: 'running' },
				},
			});

			expect(
				(
					await executeTool(
						'interrupt',
						{ ref: 'store-front/main' },
						{ ...tools, screen: 'store-front/main', utterance },
					)
				).ok,
			).toBe(true);
			expect(actions).toEqual([{ type: 'interrupt', ref: 'store-front/main' }]);
		},
	);

	it('"stop listening" never interrupts', async () => {
		const base = createToolContext();
		const session = base.tools.getState().sessions['store-front/main']!;
		const { tools, actions } = createToolContext({
			sessions: {
				...base.tools.getState().sessions,
				'store-front/main': { ...session, status: 'running' },
			},
		});
		const result = await executeTool(
			'interrupt',
			{ ref: 'store-front/main' },
			{ ...tools, screen: 'store-front/main', utterance: 'stop listening' },
		);

		expect(result.ok).toBe(false);
		expect(actions).toEqual([]);
	});

	it('a silent call, remembered as on or off', () => {
		expect(isSilentCall('hands_free', { on: false })).toBe(true);
		expect(MUTATING_TOOLS).toContain('hands_free');
		expect(describeToolCall({ name: 'hands_free', input: { on: false }, ok: true })).toBe(
			'hands_free off',
		);
	});
});

describe('fixes from the live notes', () => {
	it('a lapsed fix offer → failed and final: the kernel answers with no more tools', async () => {
		const { tools, actions } = createToolContext({
			devOffer: { ref: 'store-front/main', servers: ['api'], at: -10 * 60_000 },
		});
		const result = await executeTool('dev_offer', { accept: true }, tools);

		expect(result).toMatchObject({ ok: false, isFinal: true });
		expect(result.content).toContain('send nothing');
		expect(actions).toEqual([]);
	});

	it('ignore_words takes speech not said to anyone', () => {
		const ignoreWords = TOOL_DEFINITIONS.find((tool) => tool.name === 'ignore_words');
		const reason = ignoreWords?.input_schema.properties.reason as { enum: string[] } | undefined;

		expect(reason?.enum).toContain('not said to anyone');
	});

	describe('a bare yes with a lone permission and a switch offer', () => {
		const NOW = 100_000;
		const answerYes = { ref: 'store-front/main', decision: 'yes', text: '' };

		const withOffer = (offer: { ref: string; at: number } | null, askAt = 50_000) => {
			const { tools, actions } = createToolContext({
				asks: [
					{
						id: 'p1',
						ref: 'store-front/main',
						at: askAt,
						kind: 'permission',
						toolName: 'Bash',
						summary: 'run git push',
						input: {},
						suggestions: [],
					},
				],
				switchOffer: offer ? { ...offer, heardAt: offer.at } : null,
			});

			return {
				actions,
				run: () =>
					executeTool('answer', answerYes, {
						...tools,
						screen: null,
						utterance: 'Yes.',
						now: () => NOW,
					}),
			};
		};

		it('the offer for another session asked after the permission → not approved', async () => {
			const context = withOffer({ ref: 'checkout-api/main', at: NOW - 1000 });

			expect((await context.run()).ok).toBe(false);
			expect(context.actions).toEqual([]);
		});

		it('the permission asked after the offer, the offer for the same session, or a stale offer → approved', async () => {
			const cases = [
				withOffer({ ref: 'checkout-api/main', at: NOW - 2000 }, NOW - 1000),
				withOffer({ ref: 'store-front/main', at: NOW - 1000 }),
				withOffer({ ref: 'checkout-api/main', at: NOW - 600_000 }),
				withOffer(null),
			];

			for (const context of cases) {
				expect((await context.run()).ok).toBe(true);
				expect(context.actions.map((action) => action.type)).toContain('answer_permission');
			}
		});
	});

	it('read_state and read_history record the session as resolved, not as said', async () => {
		const { tools } = createToolContext();

		const state = await executeTool('read_state', { ref: 'checkout api main' }, tools);
		const history = await executeTool('read_history', { ref: 'checkout api main' }, tools);
		const unnamed = await executeTool('read_history', {}, tools);

		expect(state.recordAs?.input.ref).toBe('checkout-api/main');
		expect(history.recordAs?.input.ref).toBe('checkout-api/main');
		expect(unnamed.recordAs?.input.ref).toBeNull();
	});

	it('answer on a session that asked at the end of its turn → the words go to it instead', async () => {
		const base = createToolContext();
		const session = base.tools.getState().sessions['checkout-api/main']!;
		const { tools, actions } = createToolContext({
			sessions: {
				...base.tools.getState().sessions,
				'checkout-api/main': { ...session, needsUser: { text: 'asks: deploy to staging?', at: 0 } },
			},
		});
		const result = await executeTool(
			'answer',
			{ ref: 'checkout-api/main', decision: 'yes', text: '' },
			{ ...tools, utterance: 'Yes.' },
		);

		expect(result).toMatchObject({
			ok: true,
			recordAs: { name: 'send_to', input: { ref: 'checkout-api/main', text: 'Yes.' } },
		});
		expect(actions).toEqual([
			{ type: 'send', ref: 'checkout-api/main', text: 'Yes.', ack: INSTRUCTION_ACK },
		]);
	});

	describe('answer on a session with nothing waiting (note 81)', () => {
		const answerYes = { ref: 'store-front/main', decision: 'yes', text: '' };

		it('on screen → the words are forwarded there', async () => {
			const { tools, actions } = createToolContext();
			const result = await executeTool('answer', answerYes, {
				...tools,
				forwardTo: 'store-front/main',
				utterance: 'Yes, do that.',
			});

			expect(result).toMatchObject({
				ok: true,
				recordAs: { name: 'forward', input: { text: 'Yes, do that.' } },
			});
			expect(actions).toEqual([
				{ type: 'send', ref: 'store-front/main', text: 'Yes, do that.', ack: INSTRUCTION_ACK },
			]);
		});

		it('off screen and named → sent to it; not named → to the screen, like send_to', async () => {
			const named = createToolContext();
			const result = await executeTool('answer', answerYes, {
				...named.tools,
				forwardTo: 'checkout-api/main',
				utterance: 'Store front main, yes, do that.',
			});

			expect(result.recordAs).toEqual({
				name: 'send_to',
				input: { ref: 'store-front/main', text: 'Store front main, yes, do that.' },
			});
			expect(named.actions).toHaveLength(1);

			const unnamed = createToolContext();
			const refused = await executeTool('answer', answerYes, {
				...unnamed.tools,
				forwardTo: 'checkout-api/main',
				utterance: 'Yes, do that.',
			});

			// Not named: the words go to the session on screen, never to store-front/main.
			expect(refused.ok).toBe(true);
			expect(
				unnamed.actions.filter((action) => action.type === 'send').map((action) => action.ref),
			).toEqual(['checkout-api/main']);
		});

		it('a bare "yes" while another session asks → fails naming it, nothing sent', async () => {
			const asking: PendingAsk = {
				id: 'p1',
				ref: 'store-front/wrk1',
				at: 1,
				kind: 'permission',
				toolName: 'Bash',
				summary: 'run git push',
				input: {},
				suggestions: [],
			};
			const { tools, actions } = createToolContext({ asks: [asking] });
			const result = await executeTool('answer', answerYes, {
				...tools,
				asks: [asking],
				utterance: 'Yes.',
			});

			expect(result).toMatchObject({
				ok: false,
				content: expect.stringContaining('store-front/wrk1 is the one asking'),
			});
			expect(actions).toEqual([]);
		});

		it('no words at all → fails, nothing sent', async () => {
			const { tools, actions } = createToolContext();

			expect((await executeTool('answer', answerYes, tools)).ok).toBe(false);
			expect(actions).toEqual([]);
		});
	});

	it('a question called an unfinished thought → refused; a fragment still ignored', async () => {
		const { tools } = createToolContext();

		expect(
			(
				await executeTool(
					'ignore_words',
					{ reason: 'unfinished thought' },
					{ ...tools, utterance: 'Okay. Can you, um, close the agent?' },
				)
			).ok,
		).toBe(false);
		expect(
			(
				await executeTool(
					'ignore_words',
					{ reason: 'unfinished thought' },
					{ ...tools, utterance: "Let's, um." },
				)
			).ok,
		).toBe(true);
	});

	describe('decideEnding', () => {
		const ONE = 'store-front/main';
		const call = (name: string, ok = true) => ({ name, input: {}, ok });
		const base = {
			reply: '',
			calls: [] as { name: string; input: Record<string, unknown>; ok: boolean }[],
			forwardTo: ONE as string | null,
			utterance: 'set up a sub-agent to test',
			namedRefs: [] as string[],
			isSilent: false,
			mustAnswerNow: false,
		};

		it.each([
			[
				'asked what they meant on a session screen → the words go to the session',
				{ reply: 'Is this for crew/main or Voice OS setup?' },
				{ kind: 'forward_utterance' },
			],
			[
				'"which agent?" after a lookup → forwarded too',
				{
					reply: "I'm not sure which agent you mean. Can you name it?",
					calls: [call('read_state')],
				},
				{ kind: 'forward_utterance' },
			],
			[
				'"what are you referring to … or do you want to ask the session?" → forwarded',
				{
					reply:
						'What are you referring to — is something slow, or do you want to ask the session about something?',
					calls: [call('read_state')],
				},
				{ kind: 'forward_utterance' },
			],
			[
				'an offer to pass the words on ("Should I forward that to it?") → forwarded instead',
				{
					reply:
						"I don't have access to debug notes directly. What I can do is have the session check them. Should I forward that to it?",
					utterance: "can you check all the latest debug notes and figure out what's wrong?",
					calls: [call('read_state')],
				},
				{ kind: 'forward_utterance' },
			],
			[
				'"want me to send this along?" → forwarded instead',
				{ reply: 'Want me to send this along?', calls: [call('read_state')] },
				{ kind: 'forward_utterance' },
			],
			[
				'an offer of new work after a status answer → kept: it is not asking about their words',
				{
					reply: 'It finished the migration. Should I send it the next step?',
					utterance: "what's it doing?",
					calls: [call('read_state')],
				},
				{ kind: 'keep' },
			],
			[
				'"should I have it run the tests?" → kept',
				{
					reply: 'It finished. Should I have it run the tests?',
					utterance: "what's it doing?",
					calls: [call('read_state')],
				},
				{ kind: 'keep' },
			],
			[
				'a bare "yes" with several waiting → "which one?" stays: never forward a bare yes',
				{ reply: 'Which one do you mean?', utterance: 'Yes.', calls: [call('answer', false)] },
				{ kind: 'keep' },
			],
			[
				'reading options out, ending "which one?" → an answer, kept',
				{
					reply: '1. Redis. 2. A nightly job. Which one do you want?',
					calls: [call('read_state')],
				},
				{ kind: 'keep' },
			],
			[
				'Mission Control may ask which session',
				{ reply: 'Which session do you mean?', forwardTo: null },
				{ kind: 'keep' },
			],
			[
				'a forward beside a failed answer → reply dropped',
				{ reply: 'It moved on.', calls: [call('forward'), call('answer', false)] },
				{ kind: 'drop_reply' },
			],
			[
				'a lapsed offer → answered with tools off',
				{ calls: [call('dev_offer', false)], mustAnswerNow: true },
				{ kind: 'answer_now', reason: 'final' },
			],
			[
				'a lookup and no words → asked again',
				{ calls: [call('read_state')] },
				{ kind: 'answer_now', reason: 'empty' },
			],
			[
				'a silent call → nothing said',
				{ calls: [call('ignore_words')], isSilent: true },
				{ kind: 'keep' },
			],
			[
				"relaying the session's own question → an answer, kept",
				{ reply: 'It asks: did you mean staging or production?', calls: [call('read_state')] },
				{ kind: 'keep' },
			],
			[
				'"it wants to know which session should own it?" → a relayed question, kept',
				{
					reply: 'It wants to know which session should own the migration?',
					calls: [call('read_state')],
				},
				{ kind: 'keep' },
			],
			[
				'"are you asking about the build or the tests?" → asking back, forwarded',
				{ reply: 'Are you asking about the build or the tests?', calls: [call('read_state')] },
				{ kind: 'forward_utterance' },
			],
			[
				'the words name another session → "which one?" is fair',
				{
					reply: 'Which session do you mean: store-front/main or checkout-api/main?',
					namedRefs: ['checkout-api/main'],
				},
				{ kind: 'keep' },
			],
			[
				'a forward that failed ("already sent") → its explanation stays, the words are not sent again',
				{ reply: 'Did you mean to send it again?', calls: [call('forward', false)] },
				{ kind: 'keep' },
			],
			[
				'"where am I?" waved off as a greeting → answered after all',
				{
					utterance: 'Where am I?',
					calls: [
						{ name: 'ignore_words', input: { reason: 'greeting or acknowledgement' }, ok: true },
					],
				},
				{ kind: 'answer_now', reason: 'empty' },
			],
			[
				'"thanks?" waved off → still silent: too short to be a question',
				{
					utterance: 'Thanks?',
					calls: [
						{ name: 'ignore_words', input: { reason: 'greeting or acknowledgement' }, ok: true },
					],
					isSilent: true,
				},
				{ kind: 'keep' },
			],
			[
				'only send_to on a session screen → the reply is dropped: Voice OS says "Sent to X" itself',
				{ reply: 'Sent to checkout.', calls: [call('send_to')] },
				{ kind: 'drop_reply' },
			],
			[
				'only send_to on Mission Control → the reply stays: nothing else says where the words went',
				{ reply: 'Sent to checkout.', calls: [call('send_to')], forwardTo: null },
				{ kind: 'keep' },
			],
		])('%s', (_, patch, ending) =>
			expect(decideEnding({ ...base, ...patch })).toEqual(ending as never),
		);
	});

	it('a short cut-off punctuated as a question is still ignorable', async () => {
		const { tools } = createToolContext();

		expect(
			(
				await executeTool(
					'ignore_words',
					{ reason: 'unfinished thought' },
					{ ...tools, utterance: 'And can you?' },
				)
			).ok,
		).toBe(true);
	});

	it('answer on an asked session with a bare "no" while a permission opened → not sent', async () => {
		const base = createToolContext();
		const session = base.tools.getState().sessions['checkout-api/main']!;
		const permission = {
			id: 'p9',
			ref: 'checkout-api/main',
			at: 0,
			kind: 'permission' as const,
			toolName: 'Bash',
			summary: 'run git push',
			input: {},
			suggestions: [],
		};
		const { tools, actions } = createToolContext({
			asks: [permission],
			sessions: {
				...base.tools.getState().sessions,
				'checkout-api/main': { ...session, needsUser: { text: 'asks: deploy?', at: 0 } },
			},
		});
		const result = await executeTool(
			'answer',
			{ ref: 'checkout-api/main', decision: 'no', text: '' },
			{ ...tools, asks: [], utterance: 'No.' },
		);

		expect(result.ok).toBe(false);
		expect(actions).toEqual([]);
	});

	it('a finished sentence ending in a period → not an unfinished thought either', async () => {
		const { tools } = createToolContext();

		expect(
			(
				await executeTool(
					'ignore_words',
					{ reason: 'unfinished thought' },
					{ ...tools, utterance: "And can you tell me what's running." },
				)
			).ok,
		).toBe(false);
	});

	it('a yes the rewrite dropped, to a session that asked → put back, and recorded as sent', async () => {
		const base = createToolContext();
		const session = base.tools.getState().sessions['store-front/main']!;
		const { tools, actions } = createToolContext({
			sessions: {
				...base.tools.getState().sessions,
				'store-front/main': { ...session, needsUser: { text: 'asks: start reviewing?', at: 0 } },
			},
		});
		const result = await executeTool(
			'forward',
			{ text: "Let me know when you're done.", kind: 'instruction' },
			{
				...tools,
				forwardTo: 'store-front/main',
				utterance: "Yes, please. Let me know when you're done.",
			},
		);

		expect(actions).toEqual([
			{
				type: 'send',
				ref: 'store-front/main',
				text: "Yes, please. Let me know when you're done.",
				ack: INSTRUCTION_ACK,
			},
		]);
		expect(result.recordAs?.input.text).toBe("Yes, please. Let me know when you're done.");
	});

	it('long speech is never a fragment: a lyric is ignored as not said to anyone, not as unfinished', async () => {
		const { tools } = createToolContext();
		const utterance = 'Just a little closer, next to my come on and touch touch up with me.';

		expect(
			(await executeTool('ignore_words', { reason: 'unfinished thought' }, { ...tools, utterance }))
				.ok,
		).toBe(false);
		expect(
			(await executeTool('ignore_words', { reason: 'not said to anyone' }, { ...tools, utterance }))
				.ok,
		).toBe(true);
	});

	it('answer on the on-screen session that asked → recorded as a forward, so its reply is dropped', async () => {
		const base = createToolContext();
		const session = base.tools.getState().sessions['checkout-api/main']!;
		const { tools } = createToolContext({
			sessions: {
				...base.tools.getState().sessions,
				'checkout-api/main': { ...session, needsUser: { text: 'asks: deploy?', at: 0 } },
			},
		});
		const result = await executeTool(
			'answer',
			{ ref: 'checkout-api/main', decision: 'yes', text: '' },
			{ ...tools, forwardTo: 'checkout-api/main', utterance: 'Yes.' },
		);

		expect(result.recordAs).toEqual({ name: 'forward', input: { text: 'Yes.' } });
	});

	it('a long thought cut off with a dash → still ignorable as unfinished', async () => {
		const { tools } = createToolContext();

		expect(
			(
				await executeTool(
					'ignore_words',
					{ reason: 'unfinished thought' },
					{ ...tools, utterance: 'So what I was thinking is maybe the, um, the thing with the—' },
				)
			).ok,
		).toBe(true);
	});

	it('a question about a waiting permission → asked aside; the permission is not answered', async () => {
		const base = createToolContext();
		const session = base.tools.getState().sessions['store-front/main']!;
		const permission = {
			id: 'p5',
			ref: 'store-front/main',
			at: 0,
			kind: 'permission' as const,
			toolName: 'Bash',
			summary: 'run git push --force',
			input: {},
			suggestions: [],
		};
		const { tools, actions } = createToolContext({
			asks: [permission],
			sessions: {
				...base.tools.getState().sessions,
				'store-front/main': { ...session, status: 'blocked' },
			},
		});

		await executeTool(
			'forward',
			{ text: 'What does that command do?', kind: 'question' },
			{ ...tools, forwardTo: 'store-front/main', utterance: 'What does that command do?' },
		);

		expect(actions).toEqual([
			{ type: 'send', ref: 'store-front/main', text: 'What does that command do?', aside: true },
		]);
	});

	it.each([
		['Can you reinstall Voice OS and restart it?', true],
		['Rebuild Voice OS and crew, please.', true],
		['Voice OS, make a worktree in store front for the search fix.', false],
		['Okay, setup: register the new project.', false],
		['Can you add a worktree for the search fix?', false],
	])(
		"from another session's screen, %p → misrouted to setup: %p",
		async (utterance, isMisrouted) => {
			const base = createToolContext().tools.getState();
			const state = {
				...base,
				sessions: {
					...base.sessions,
					'checkout-api/main': { ...base.sessions['checkout-api/main']!, isPinned: true },
				},
			};

			expect(
				await isMisroutedToSetup({
					judge: englishJudge,
					state,
					ref: 'checkout-api/main',
					forwardTo: 'store-front/main',
					utterance,
				}),
			).toBe(isMisrouted);
		},
	);

	it('the setup session on screen, or no session on screen → never refused', async () => {
		const base = createToolContext().tools.getState();
		const state = {
			...base,
			sessions: {
				...base.sessions,
				'checkout-api/main': { ...base.sessions['checkout-api/main']!, isPinned: true },
			},
		};
		const utterance = 'Can you reinstall Voice OS?';

		expect(
			await isMisroutedToSetup({
				judge: englishJudge,
				state,
				ref: 'checkout-api/main',
				forwardTo: 'checkout-api/main',
				utterance,
			}),
		).toBe(false);
		expect(
			await isMisroutedToSetup({
				judge: englishJudge,
				state,
				ref: 'checkout-api/main',
				forwardTo: null,
				utterance,
			}),
		).toBe(false);
	});
});

describe('open_doc', () => {
	const withDocs = () => {
		const { tools } = createToolContext();
		const state = tools.getState();
		const session = state.sessions['store-front/main']!;

		state.sessions['store-front/main'] = {
			...session,
			stream: [
				{
					id: 'd1',
					at: 1,
					kind: 'doc',
					url: 'https://claude.ai/artifact/risks',
					title: 'Retry risks',
				},
				{
					id: 'd2',
					at: 2,
					kind: 'doc',
					url: 'https://claude.ai/artifact/plan',
					title: 'Checkout plan',
				},
			],
		};
		const opened: [string, string][] = [];

		return {
			opened,
			context: {
				...tools,
				screen: 'store-front/main',
				openUrl: (url: string, title: string) => {
					opened.push([url, title]);

					return true;
				},
			},
		};
	};

	it("no title → the session's newest doc, opened in the developer's tab", async () => {
		const { context, opened } = withDocs();

		const result = await executeTool('open_doc', { ref: null, title: null }, context);

		expect(result.ok).toBe(true);
		expect(opened).toEqual([['https://claude.ai/artifact/plan', 'Checkout plan']]);
	});

	it('words from a title → that doc', async () => {
		const { context, opened } = withDocs();

		await executeTool('open_doc', { ref: 'store-front/main', title: 'risks' }, context);

		expect(opened).toEqual([['https://claude.ai/artifact/risks', 'Retry risks']]);
	});

	it.each([
		['a session with no doc', { ref: 'checkout-api/main', title: null }, 'no doc yet'],
		['a title that matches none', { ref: null, title: 'budget' }, 'no doc titled like "budget"'],
	])('%s → says so, opens nothing', async (_label, input, message) => {
		const { context, opened } = withDocs();

		const result = await executeTool('open_doc', input, context);

		expect(result.ok).toBe(false);
		expect(result.content).toContain(message);
		expect(opened).toEqual([]);
	});

	// Debug note 26: "show me the kernel prompt" called open_doc, then asked for a doc name.
	it('no such doc on the session on screen → the words are for that session: forward them', async () => {
		const { context, opened } = withDocs();

		const result = await executeTool(
			'open_doc',
			{ ref: null, title: 'kernel prompt' },
			{ ...context, forwardTo: context.screen },
		);

		expect(result.ok).toBe(false);
		expect(result.content).toContain('Forward their words to it');
		expect(opened).toEqual([]);
	});

	it('no tab took it → says to click the card', async () => {
		const { context } = withDocs();

		const result = await executeTool(
			'open_doc',
			{ ref: null, title: null },
			{ ...context, openUrl: () => false },
		);

		expect(result.ok).toBe(false);
		expect(result.content).toContain('click the doc card');
	});

	it('"the risks doc" → the doc about risks: words that name the kind of thing are left out', async () => {
		const { context, opened } = withDocs();

		await executeTool('open_doc', { ref: null, title: 'the risks doc' }, context);

		expect(opened).toEqual([['https://claude.ai/artifact/risks', 'Retry risks']]);
	});

	it('"the risk doc", as spoken, → the doc titled "Retry risks"', async () => {
		const { context, opened } = withDocs();

		await executeTool('open_doc', { ref: null, title: 'the risk doc' }, context);

		expect(opened).toEqual([['https://claude.ai/artifact/risks', 'Retry risks']]);
	});

	it('an unknown session, or no session on screen → says so, opens nothing', async () => {
		const { context, opened } = withDocs();

		const unknown = await executeTool('open_doc', { ref: 'signals/main', title: null }, context);
		const noScreen = await executeTool(
			'open_doc',
			{ ref: null, title: null },
			{ ...context, screen: null },
		);

		expect(unknown.ok).toBe(false);
		expect(noScreen.content).toContain('No session on screen');
		expect(opened).toEqual([]);
	});

	it('the kernel is told the three newest doc titles, each once', () => {
		const { context } = withDocs();
		const state = context.getState();
		const session = state.sessions['store-front/main']!;
		const doc = (id: string, title: string) => ({
			id,
			at: 3,
			kind: 'doc' as const,
			url: `https://claude.ai/artifact/${id}`,
			title,
		});

		state.sessions['store-front/main'] = {
			...session,
			stream: [...session.stream, doc('c', 'C'), doc('d', 'D'), doc('e', 'E')],
		};

		expect(
			describeSession({ state, ref: 'store-front/main', isDetailed: false, now: 4 }),
		).toMatchObject({
			docs: ['E', 'D', 'C'],
		});
	});

	it('the session description lists its docs, newest first, for the kernel', () => {
		const { context } = withDocs();

		expect(
			describeSession({
				state: context.getState(),
				ref: 'store-front/main',
				isDetailed: false,
				now: 3,
			}),
		).toMatchObject({ docs: ['Checkout plan', 'Retry risks'] });
	});
});

describe('words that ask about a waiting question', () => {
	const REF = 'store-front/main';
	const question: PendingAsk = {
		id: 'q9',
		ref: REF,
		at: 1,
		kind: 'question',
		input: {},
		questions: [
			{
				question: 'Which database?',
				multiSelect: false,
				options: [{ label: 'Postgres' }, { label: 'SQLite' }],
			},
		],
	};

	const blockedOn = (ask: PendingAsk) => {
		const base = createToolContext().tools.getState();

		return createToolContext({
			asks: [ask],
			sessions: { ...base.sessions, [REF]: { ...base.sessions[REF]!, status: 'blocked' } },
		});
	};

	const choose = async (utterance: string, text = 'SQLite') => {
		const { tools, actions } = blockedOn(question);
		const result = await executeTool(
			'answer',
			{ ref: REF, decision: 'choose', text },
			{ ...tools, asks: [question], forwardTo: REF, utterance },
		);

		return { result, actions };
	};

	it('"what does option two do?" chosen → forwarded as a question, which withdraws it', async () => {
		const { result, actions } = await choose('What does option two do?');

		expect(actions).toEqual([
			{ type: 'send', ref: REF, text: 'What does option two do?', aside: true },
		]);
		expect(result.content).toContain('withdrawn');
		expect(result.recordAs).toEqual({
			name: 'forward',
			input: { text: 'What does option two do?', kind: 'question' },
		});
	});

	it.each([
		['The second?', 'SQLite'],
		['Postgres?', 'Postgres'],
		['Option two?', 'SQLite'],
		['SQLite.', 'SQLite'],
	])('%p chosen → still the pick', async (utterance, text) => {
		const { actions } = await choose(utterance, text);

		expect(actions).toEqual([
			{
				type: 'answer_question',
				askId: 'q9',
				answers: { 'Which database?': text },
				isSpoken: true,
			},
		]);
	});

	const labelled = (labels: string[]): QuestionAsk => ({
		...(question as QuestionAsk),
		questions: [
			{
				question: 'Which database?',
				multiSelect: false,
				options: labels.map((label) => ({ label })),
			},
		],
	});

	const isForwarded = async (labels: string[], utterance: string) =>
		(await readOptionReply({
			ask: labelled(labels),
			utterance,
			judge: englishJudge,
			sessions: [],
		})) === 'question';

	it.each([
		[['Postgres (Recommended)', 'SQLite'], 'Postgres?'],
		[['Use Postgres', 'Use SQLite'], 'Postgres?'],
		[['Postgres', 'SQLite'], 'use Postgres?'],
		[['Postgres', 'SQLite'], 'Postgres?"'],
		[['Postgres', 'SQLite'], 'the second one?'],
		[['Postgres', 'Postgres + Redis'], 'Postgres?'],
		[['Keep it', 'Keep both'], 'Keep it?'],
		[['Do one', 'Do both'], 'Do both?'],
	])('labels %p, %p said → a pick, not forwarded', async (labels, utterance) =>
		expect(await isForwarded(labels, utterance)).toBe(false),
	);

	it.each([
		[['Postgres (Recommended)', 'SQLite'], 'what does option two do?'],
		[['Postgres (Recommended)', 'SQLite'], "what's the difference between Postgres and SQLite?"],
		[['Postgres', 'SQLite'], 'Postgres or SQLite?'],
		[['Postgres', 'SQLite'], 'why Postgres?'],
		[['Postgres', 'SQLite'], 'would Postgres handle the nightly import load?'],
	])('labels %p, %p said → a question, forwarded', async (labels, utterance) =>
		expect(await isForwarded(labels, utterance)).toBe(true),
	);

	it('"Postgres?" chosen with the label "Postgres (Recommended)" → the pick, the label answered', async () => {
		const recommended = labelled(['Postgres (Recommended)', 'SQLite']);
		const { tools, actions } = blockedOn(recommended);

		await executeTool(
			'answer',
			{ ref: REF, decision: 'choose', text: 'Postgres (Recommended)' },
			{ ...tools, asks: [recommended], forwardTo: REF, utterance: 'Postgres?' },
		);

		expect(actions).toEqual([
			{
				type: 'answer_question',
				askId: 'q9',
				answers: { 'Which database?': 'Postgres (Recommended)' },
				isSpoken: true,
			},
		]);
	});

	it('a plan or permission asked about with choose → refused as before, nothing forwarded', async () => {
		const plan: PendingAsk = { id: 'l9', ref: REF, at: 1, kind: 'plan', input: {}, plan: 'x' };
		const permission: PendingAsk = {
			id: 'p9',
			ref: REF,
			at: 1,
			kind: 'permission',
			toolName: 'Bash',
			summary: 'run git push',
			input: {},
			suggestions: [],
		};

		for (const ask of [plan, permission]) {
			const { tools, actions } = blockedOn(ask);
			const result = await executeTool(
				'answer',
				{ ref: REF, decision: 'choose', text: 'x' },
				{ ...tools, asks: [ask], forwardTo: REF, utterance: 'What does step two do?' },
			);

			expect(result.ok).toBe(false);
			expect(actions).toEqual([]);
		}
	});

	it('a question forwarded while a question waits → the result says it is withdrawn; a plan → asked aside', async () => {
		const plan: PendingAsk = { id: 'l9', ref: REF, at: 1, kind: 'plan', input: {}, plan: 'x' };

		const forward = async (ask: PendingAsk) => {
			const { tools } = blockedOn(ask);

			return executeTool(
				'forward',
				{ text: 'Why SQLite?', kind: 'question' },
				{ ...tools, asks: [ask], forwardTo: REF, utterance: 'Why SQLite?' },
			);
		};

		expect(await forward(question)).toMatchObject({ ok: true, note: 'question withdrawn' });
		expect((await forward(question)).content).toContain('withdrawn');
		expect(await forward(plan)).toMatchObject({ ok: true, note: 'aside' });
	});
});

describe('read_state on the session on screen', () => {
	it('carries the rule that its own Claude answers questions about its work; another session does not', async () => {
		const { tools } = createToolContext();
		const onScreen = await executeTool(
			'read_state',
			{ ref: 'store-front/main' },
			{ ...tools, screen: 'store-front/main' },
		);
		const other = await executeTool(
			'read_state',
			{ ref: 'store-front/wrk1' },
			{ ...tools, screen: 'store-front/main' },
		);

		expect(JSON.parse(onScreen.content).on_screen).toContain(
			'forward the words with kind question',
		);
		expect(JSON.parse(other.content).on_screen).toBeUndefined();
	});
});
