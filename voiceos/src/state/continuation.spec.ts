import { describe, expect, it } from 'bun:test';
import type { Input, State } from '../shared/protocol.js';
import { CONTINUATION_MS, hasMostWords, spliceTail } from './continuation.js';
import {
	idleSession,
	permissionAsk,
	REF,
	run,
	runningSession,
	worktree,
} from '../../test/support/reduce.js';

const FIRST = 'check the logs for the timeout errors in';
const JOINED = 'Check the logs for the timeout errors in the checkout worker.';
const REST = 'The checkout worker.';

const said = (text: string, patch: Partial<Extract<Input, { type: 'send' }>> = {}): Input => ({
	type: 'send',
	ref: REF,
	text,
	isSpoken: true,
	ack: { kind: 'instruction' },
	...patch,
});
const continued = (text = JOINED, rest = REST): Input => said(text, { continues: { rest } });
const sessionOf = (state: State) => state.sessions[REF];

describe('hasMostWords', () => {
	it('case, punctuation and filler do not count; most of the words must be there', () => {
		expect(hasMostWords('Check the logs, for the timeout errors in—', JOINED)).toBe(true);
		expect(hasMostWords(FIRST, 'Look at the dashboards for slow pages.')).toBe(false);
	});

	it('a one- or two-word first half must be there whole', () => {
		expect(hasMostWords('revert it', 'Revert the change to the router.')).toBe(true);
		expect(hasMostWords('revert migrations', 'Revert the change to the router.')).toBe(false);
	});

	it('the boundary: three of five words is enough, two of five is not', () => {
		expect(hasMostWords('alpha beta gamma delta epsilon', 'alpha beta gamma')).toBe(true);
		expect(hasMostWords('alpha beta gamma delta epsilon', 'alpha beta')).toBe(false);
	});
});

describe('spliceTail', () => {
	it('the whole message, or its trailing fragment, becomes the joined sentence', () => {
		expect(spliceTail({ carried: FIRST, fragment: FIRST, joined: JOINED })).toBe(JOINED);
		expect(
			spliceTail({ carried: `also run the tests ${FIRST}`, fragment: FIRST, joined: JOINED }),
		).toBe(`also run the tests ${JOINED}`);
	});

	it('a fragment no longer at the end → not spliced', () =>
		expect(
			spliceTail({ carried: `${FIRST} and more`, fragment: FIRST, joined: JOINED }),
		).toBeNull());
});

describe('a continuation replaces its first half', () => {
	it('still queued → rewritten in place, nothing said, nothing else queued', () => {
		const first = run([said(FIRST)], { start: runningSession(), at: 1000 });
		const { state, effects } = run([continued()], { start: first.state, at: 4000 });

		expect(sessionOf(state)?.queue.map((message) => message.text)).toEqual([JOINED]);
		expect(effects).toEqual([]);
	});

	it('running → cut quietly, the whole sentence first; the cut turn is not narrated', () => {
		const first = run([said(FIRST)], { start: idleSession(), at: 1000 });
		const replaced = run([continued()], { start: first.state, at: 4000 });
		const cut = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Looking at the logs' }], {
			start: replaced.state,
			at: 5000,
		});

		expect(replaced.effects).toEqual([{ type: 'worker_interrupt', ref: REF, reason: 'follow-up' }]);
		expect(sessionOf(replaced.state)?.queue[0]).toMatchObject({
			text: JOINED,
			isFollowUp: true,
			reportOwed: true,
		});
		expect(cut.effects.some((effect) => effect.type === 'narrate')).toBe(false);
		expect(cut.effects).toContainEqual(
			expect.objectContaining({ type: 'worker_send', text: JOINED }),
		);
	});

	it('a third part before the cut turn ends → the waiting sentence grows, no second cut', () => {
		const first = run([said(FIRST)], { start: idleSession(), at: 1000 });
		const second = run([continued()], { start: first.state, at: 4000 });
		const third = run(
			[continued(`${JOINED.slice(0, -1)} from this morning.`, 'From this morning.')],
			{ start: second.state, at: 6000 },
		);
		const ended = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: '' }], {
			start: third.state,
			at: 7000,
		});

		expect(third.effects).toEqual([]);
		expect(ended.effects.filter((effect) => effect.type === 'worker_send')).toEqual([
			expect.objectContaining({
				text: 'Check the logs for the timeout errors in the checkout worker from this morning.',
			}),
		]);
	});

	it('asked aside → withdrawn (its answer never said) and asked aside again, whole', () => {
		const first = run([said('why are the timeout errors in', { aside: true })], {
			start: runningSession(),
			at: 1000,
		});
		const firstAside = sessionOf(first.state)?.stream.at(-1);
		const replaced = run([continued('Why are the timeout errors in the checkout worker?')], {
			start: first.state,
			at: 4000,
		});
		const late = run(
			[
				{
					type: 'aside_settled',
					ref: REF,
					itemId: firstAside?.id ?? '',
					question: 'why are the timeout errors in',
					status: 'answered',
					answer: 'Because.',
				},
			],
			{ start: replaced.state, at: 5000 },
		);

		expect(
			sessionOf(replaced.state)?.stream.find((item) => item.id === firstAside?.id),
		).toMatchObject({
			status: 'withdrawn',
		});
		expect(replaced.effects).toEqual([
			expect.objectContaining({
				type: 'side_answer',
				question: 'Why are the timeout errors in the checkout worker?',
			}),
		]);
		expect(late.effects).toEqual([]);
	});

	it.each(['queued', 'failed'] as const)(
		'a withdrawn aside settling %s → nothing queued',
		(status) => {
			const first = run([said('why are the timeout errors in', { aside: true })], {
				start: runningSession(),
				at: 1000,
			});
			const itemId = sessionOf(first.state)?.stream.at(-1)?.id ?? '';
			const replaced = run([continued('Why are the timeout errors in the checkout worker?')], {
				start: first.state,
				at: 4000,
			});
			const late = run(
				[{ type: 'aside_settled', ref: REF, itemId, question: 'why', status, answer: null }],
				{ start: replaced.state, at: 5000 },
			);

			expect(late.effects).toEqual([]);
			expect(sessionOf(late.state)?.queue).toEqual([]);
		},
	);

	it('already answered → only the new words go', () => {
		const first = run([said(FIRST)], { start: idleSession(), at: 1000 });
		const answered = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Nothing there.' }], {
			start: first.state,
			at: 2000,
		});
		const { effects } = run([continued()], { start: answered.state, at: 4000 });

		expect(effects).toContainEqual(expect.objectContaining({ type: 'worker_send', text: REST }));
	});

	it('too long after, or the last words went elsewhere → only the new words', () => {
		const first = run([said(FIRST)], { start: runningSession(), at: 1000 });
		const late = run([continued()], { start: first.state, at: 1000 + CONTINUATION_MS + 1 });
		const withOther = run(
			[
				{ type: 'worktrees', worktrees: [worktree(REF), worktree('store/wrk1')] },
				said('run the linter', { ref: 'store/wrk1' }),
			],
			{ start: first.state, at: 2000 },
		);
		const elsewhere = run([continued()], { start: withOther.state, at: 4000 });

		expect(sessionOf(late.state)?.queue.map((message) => message.text)).toEqual([FIRST, REST]);
		expect(sessionOf(elsewhere.state)?.queue.map((message) => message.text)).toEqual([FIRST, REST]);
	});

	it('the same words again, even over a running first half → nothing changes, nothing cut', () => {
		const first = run([said(FIRST)], { start: idleSession(), at: 1000 });
		const again = run([continued(FIRST, '')], { start: first.state, at: 3000 });

		expect(sessionOf(again.state)?.queue).toEqual([]);
		expect(again.effects).toEqual([]);
	});

	it('running with other work waiting → the replacement goes first, the rest keeps its place, the promise moves', () => {
		const first = run([said(FIRST)], { start: idleSession(), at: 1000 });
		const waiting = run([{ type: 'send', ref: REF, text: 'then run the tests' }], {
			start: first.state,
			at: 2000,
		});
		const replaced = run([said(JOINED, { continues: { rest: REST }, ack: { kind: 'question' } })], {
			start: waiting.state,
			at: 4000,
		});

		expect(sessionOf(replaced.state)?.queue.map((message) => message.text)).toEqual([
			JOINED,
			'then run the tests',
		]);
		expect(sessionOf(replaced.state)?.queue[0]?.reportOwed).toBe(true);
	});

	it('merged into a waiting follow-up → only its part of that message changes', () => {
		const running = run([said('refactor the router')], { start: idleSession(), at: 1000 }).state;
		const followUp = run([said('and also run the tests')], { start: running, at: 2000 }).state;
		const merged = run([said(FIRST)], { start: followUp, at: 3000 }).state;
		const { state } = run([continued()], { start: merged, at: 5000 });

		expect(sessionOf(state)?.queue.map((message) => message.text)).toEqual([
			`and also run the tests ${JOINED}`,
		]);
	});

	it('asked aside, but the session is idle by then → sent as a normal message', () => {
		const first = run([said('why are the timeout errors in', { aside: true })], {
			start: runningSession(),
			at: 1000,
		});
		const idle = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Done.' }], {
			start: first.state,
			at: 2000,
		});
		const { effects } = run([continued('Why are the timeout errors in the checkout worker?')], {
			start: idle.state,
			at: 4000,
		});

		expect(effects).toContainEqual(
			expect.objectContaining({
				type: 'worker_send',
				text: 'Why are the timeout errors in the checkout worker?',
			}),
		);
	});

	it('an ask answered in between → the first half is no longer the last words: only the new ones', () => {
		const first = run([said(FIRST)], { start: runningSession(), at: 1000 });
		const asked = run(
			[
				{ type: 'ask_opened', ask: permissionAsk('p1') },
				{ type: 'answer_permission', askId: 'p1', decision: 'allow' },
			],
			{ start: first.state, at: 2000 },
		);
		const { state } = run([continued()], { start: asked.state, at: 4000 });

		expect(sessionOf(state)?.queue.map((message) => message.text)).toEqual([FIRST, REST]);
	});

	it('flagged, but the sentence does not hold the first half → only the new words', () => {
		const first = run([said(FIRST)], { start: runningSession(), at: 1000 });
		const { state } = run([continued('Deploy the staging branch now.', 'Now.')], {
			start: first.state,
			at: 3000,
		});

		expect(sessionOf(state)?.queue.map((message) => message.text)).toEqual([FIRST, 'Now.']);
	});

	it('already answered and the new part is a question to a working session → asked aside', () => {
		const first = run([said(FIRST)], { start: idleSession(), at: 1000 });
		const busy = run(
			[
				{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'None.' },
				{ type: 'send', ref: REF, text: 'refactor the router' },
			],
			{ start: first.state, at: 2000 },
		);
		const { effects } = run([said(JOINED, { continues: { rest: 'Why?', isAside: true } })], {
			start: busy.state,
			at: 4000,
		});

		expect(effects).toContainEqual(
			expect.objectContaining({ type: 'side_answer', question: 'Why?' }),
		);
	});
});

describe('which turn is running', () => {
	it('set when sent, the head when dequeued, cleared by stop, interrupt and exit', () => {
		const sent = run([said(FIRST)], { start: idleSession(), at: 1000 });
		const queued = run([said('and the tests', { isSpoken: false })], {
			start: sent.state,
			at: 2000,
		});
		const next = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Done.' }], {
			start: queued.state,
			at: 3000,
		});
		const head = sessionOf(queued.state)?.queue[0]?.id;

		expect(sessionOf(sent.state)?.currentSendId).toBeString();
		expect(sessionOf(next.state)?.currentSendId).toBe(head ?? '');
		expect(
			sessionOf(
				run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: '' }], { start: sent.state }).state,
			)?.currentSendId,
		).toBeNull();

		for (const input of [
			{ type: 'interrupt', ref: REF },
			{ type: 'stop_session', ref: REF },
			{ type: 'worker_exited', ref: REF, error: null },
		] as Input[]) {
			expect(sessionOf(run([input], { start: sent.state }).state)?.currentSendId).toBeNull();
		}
	});
});
