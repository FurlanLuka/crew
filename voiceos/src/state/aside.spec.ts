import { describe, expect, it } from 'bun:test';
import { REF, idleSession, permissionAsk, run, runningSession } from '../../test/support/reduce.js';
import type { State, StreamItem } from '../shared/protocol.js';
import { QUEUED_ASIDE_LINE, SENT_ASIDE_LINE } from './aside.js';

const asidesOf = (state: State): Extract<StreamItem, { kind: 'aside' }>[] =>
	(state.sessions[REF]?.stream ?? []).flatMap((item) => (item.kind === 'aside' ? [item] : []));

const askAside = (start: State, question = 'which file did you change?') =>
	run([{ type: 'send', ref: REF, text: question, aside: true }], { start });

describe('asking aside', () => {
	it('running session → an asking item and a side answer, nothing queued or interrupted', () => {
		const { state, effects } = askAside(runningSession());
		const [aside] = asidesOf(state);

		expect(aside).toMatchObject({ question: 'which file did you change?', status: 'asking' });
		expect(state.sessions[REF]?.queue).toEqual([]);
		expect(effects).toEqual([
			{
				type: 'side_answer',
				ref: REF,
				itemId: aside?.id ?? '',
				question: 'which file did you change?',
			},
		]);
	});

	it('the session went idle meanwhile → sent as a normal message', () => {
		const { state, effects } = askAside(idleSession());

		expect(asidesOf(state)).toEqual([]);
		expect(effects).toEqual([
			{ type: 'worker_send', ref: REF, text: 'which file did you change?' },
		]);
	});

	it('the same question while its answer is on the way → heard once', () => {
		const first = askAside(runningSession()).state;
		const { state, effects } = askAside(first, '  Which file did you change? ');

		expect(asidesOf(state)).toHaveLength(1);
		expect(effects).toEqual([]);
	});

	it('the same question after it was answered → asked again', () => {
		const first = askAside(runningSession()).state;
		const itemId = asidesOf(first)[0]?.id ?? '';
		const answered = run(
			[
				{
					type: 'aside_settled',
					ref: REF,
					itemId,
					question: 'which file did you change?',
					status: 'answered',
					answer: 'router.ts',
				},
			],
			{ start: first },
		).state;

		expect(asidesOf(askAside(answered).state)).toHaveLength(2);
	});
});

describe('aside_settled', () => {
	const settle = (
		start: State,
		status: 'answered' | 'queued' | 'failed',
		answer: string | null = null,
	) => {
		const itemId = asidesOf(start)[0]?.id ?? 'gone';

		return run(
			[
				{
					type: 'aside_settled',
					ref: REF,
					itemId,
					question: 'which file did you change?',
					status,
					answer,
				},
			],
			{ start },
		);
	};

	it('a tagged answer → the page keeps the text without the tag', () => {
		const { state } = settle(
			askAside(runningSession()).state,
			'answered',
			'<spoken>The router.</spoken>\nIn src/router.ts.',
		);

		expect(asidesOf(state)[0]).toMatchObject({ answer: 'In src/router.ts.' });
	});

	it('answered → the item holds the answer and the narrator says it', () => {
		const { state, effects } = settle(askAside(runningSession()).state, 'answered', 'The router.');

		expect(asidesOf(state)[0]).toMatchObject({ status: 'answered', answer: 'The router.' });
		expect(effects).toEqual([
			{
				type: 'narrate_aside',
				ref: REF,
				question: 'which file did you change?',
				answer: 'The router.',
			},
		]);
	});

	it('queued → it waits behind the work, and Voice OS says so', () => {
		const { state, effects } = settle(askAside(runningSession()).state, 'queued');

		expect(asidesOf(state)[0]?.status).toBe('queued');
		expect(state.sessions[REF]?.queue.map((message) => message.text)).toEqual([
			'which file did you change?',
		]);
		expect(effects).toEqual([
			{ type: 'speak', text: QUEUED_ASIDE_LINE, source: 'kernel', ref: REF, isNamed: true },
		]);
	});

	it('queued after the turn ended → sent at once', () => {
		const asked = askAside(runningSession()).state;
		const ended = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: '' }], {
			start: asked,
		}).state;
		const { effects } = settle(ended, 'queued');

		expect(effects).toEqual([
			{ type: 'worker_send', ref: REF, text: 'which file did you change?' },
			{ type: 'speak', text: SENT_ASIDE_LINE, source: 'kernel', ref: REF, isNamed: true },
		]);
	});

	it('queued while a permission waits → queued, the permission untouched', () => {
		const asked = askAside(runningSession()).state;
		const waiting = run([{ type: 'ask_opened', ask: permissionAsk('p1') }], { start: asked }).state;
		const { state, effects } = settle(waiting, 'queued');

		expect(state.asks.map((ask) => ask.id)).toEqual(['p1']);
		expect(effects.some((effect) => effect.type === 'resolve_ask')).toBe(false);
		expect(state.sessions[REF]?.queue).toHaveLength(1);
	});

	it('failed on a session stopped meanwhile → queued without restarting it', () => {
		const asked = askAside(runningSession()).state;
		const stopped = run([{ type: 'stop_session', ref: REF }], { start: asked }).state;
		const { state, effects } = settle(stopped, 'failed');

		expect(state.sessions[REF]?.status).toBe('stopped');
		expect(state.sessions[REF]?.queue).toHaveLength(1);
		expect(effects.some((effect) => effect.type === 'worker_start')).toBe(false);
	});

	it('its item already left the stream → still queued, never lost', () => {
		const { state } = settle(runningSession(), 'queued');

		expect(state.sessions[REF]?.queue.map((message) => message.text)).toEqual([
			'which file did you change?',
		]);
	});
});

describe('asking aside while a plan or permission waits', () => {
	it('a question about the waiting plan → answered aside, the plan still waits, nothing resolved', () => {
		const planAsk = {
			id: 'plan1',
			ref: REF,
			at: 1,
			kind: 'plan' as const,
			input: {},
			plan: 'Move the kernel rules into code.',
		};
		const waiting = run([{ type: 'ask_opened', ask: planAsk }], { start: runningSession() }).state;
		const { state, effects } = askAside(waiting, 'why does step three touch the kernel?');

		expect(state.asks.map((ask) => ask.id)).toEqual(['plan1']);
		expect(asidesOf(state)).toHaveLength(1);
		expect(effects.map((effect) => effect.type)).toEqual(['side_answer']);
	});

	it('the same words without aside → they decline the plan, as before', () => {
		const planAsk = { id: 'plan1', ref: REF, at: 1, kind: 'plan' as const, input: {}, plan: 'x' };
		const waiting = run([{ type: 'ask_opened', ask: planAsk }], { start: runningSession() }).state;
		const { state, effects } = run(
			[{ type: 'send', ref: REF, text: 'use the new table instead' }],
			{
				start: waiting,
			},
		);

		expect(state.asks).toEqual([]);
		expect(effects).toContainEqual(
			expect.objectContaining({ type: 'resolve_ask', askId: 'plan1' }),
		);
	});
});

describe('a note that came with the question', () => {
	const withNote = () =>
		run([{ type: 'send', ref: REF, text: 'which note first?', aside: true, note: 'notes path' }], {
			start: runningSession(),
		});

	it('goes to the fork, and to the turn it becomes when the fork cannot answer', () => {
		const asked = withNote();
		const itemId = asidesOf(asked.state)[0]?.id ?? '';
		const queued = run(
			[
				{
					type: 'aside_settled',
					ref: REF,
					itemId,
					question: 'which note first?',
					status: 'queued',
					answer: null,
				},
			],
			{ start: asked.state },
		);

		expect(asked.effects).toEqual([
			{ type: 'side_answer', ref: REF, itemId, question: 'which note first?', note: 'notes path' },
		]);
		expect(queued.state.sessions[REF]?.queue.at(-1)).toMatchObject({
			text: 'which note first?',
			note: 'notes path',
		});
	});
});
