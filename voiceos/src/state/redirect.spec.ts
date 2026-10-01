import { describe, expect, it } from 'bun:test';
import type { Input, State } from '../shared/protocol.js';
import type { Effect } from './reducer.js';
import { idleSession, permissionAsk, REF, run, runningSession } from '../../test/support/reduce.js';

const REDIRECT = 'Stop that and fix the login bug first.';

const redirect = (patch: Partial<Extract<Input, { type: 'send' }>> = {}): Input => ({
	type: 'send',
	ref: REF,
	text: REDIRECT,
	isSpoken: true,
	ack: { kind: 'redirect' },
	...patch,
});
const said = (effects: Effect[]) =>
	effects.filter((effect) => effect.type === 'speak').map((effect) => effect.text);
const askOf = (state: State) => state.asks.find((ask) => ask.kind === 'redirect');
const queueOf = (state: State) => state.sessions[REF]?.queue.map((message) => message.text);
const held = () => run([redirect()], { start: runningSession(), at: 1000 });
const answer = (state: State, isApproved: boolean, message?: string, at = 2000) =>
	run(
		[
			{
				type: 'answer_redirect',
				askId: askOf(state)?.id ?? '',
				isApproved,
				...(message ? { message } : {}),
			},
		],
		{ start: state, at },
	);

describe('a redirect to a working session', () => {
	it('asks first: only the question is said, nothing queued or owed yet', () => {
		const { state, effects } = held();

		expect(askOf(state)).toMatchObject({ text: REDIRECT });
		expect(effects).toEqual([
			{ type: 'drop_speech', ref: REF, before: 1000 },
			{
				type: 'speak',
				text: 'store/main is still on refactor the router. Stop it and switch? Say yes, or it goes after.',
				source: 'alert',
				ref: REF,
				isAsking: true,
			},
			{ type: 'expire_command', askId: expect.any(String) },
		]);
		expect(queueOf(state)).toEqual([]);
		expect(state.sessions[REF]?.reportOwed).toBe(false);
	});

	it('yes → the running work is cut quietly and the redirect goes first', () => {
		const { state, effects } = answer(held().state, true);

		expect(askOf(state)).toBeUndefined();
		expect(state.sessions[REF]?.queue[0]).toMatchObject({ text: REDIRECT, isFollowUp: true });
		expect(effects).toEqual([{ type: 'worker_interrupt', ref: REF, reason: 'follow-up' }]);
	});

	it('yes with words → they join the instruction', () =>
		expect(queueOf(answer(held().state, true, 'And use staging.').state)).toEqual([
			`${REDIRECT} And use staging.`,
		]));

	it('a bare no, or no answer in time → after the current work, and said so', () => {
		const no = answer(held().state, false);
		const lapsed = run([{ type: 'command_expired', askId: askOf(held().state)?.id ?? '' }], {
			start: held().state,
		});

		for (const result of [no, lapsed]) {
			expect(queueOf(result.state)).toEqual([REDIRECT]);
			expect(said(result.effects)).toEqual(['Okay, after its current work.']);
			expect(askOf(result.state)).toBeUndefined();
		}
	});

	it('"no, do X instead" → the redirect is dropped and only X goes', () => {
		const { state } = answer(held().state, false, 'Run the seed script instead.');

		expect(queueOf(state)).toEqual(['Run the seed script instead.']);
	});

	it('a permission opening → the redirect goes after the work, said after the permission', () => {
		const { state, effects } = run([{ type: 'ask_opened', ask: permissionAsk('p1') }], {
			start: held().state,
		});

		expect(queueOf(state)).toEqual([REDIRECT]);
		expect(said(effects)).toEqual([
			'store/main wants to run git push. Allow?',
			'Okay, after its current work.',
		]);
	});

	it('other words → the redirect is kept for after, quietly, and the words follow it', () => {
		const { state, effects } = run(
			[{ type: 'send', ref: REF, text: 'also run the linter', ack: { kind: 'instruction' } }],
			{ start: held().state },
		);

		expect(queueOf(state)).toEqual([REDIRECT, 'also run the linter']);
		expect(askOf(state)).toBeUndefined();
		expect(said(effects)).toEqual(['Okay, after its current work.']);
	});

	it('a /clear said while it waits → the redirect kept for after, the /clear held instead', () => {
		const { state } = run([{ type: 'send', ref: REF, text: '/clear' }], { start: held().state });

		expect(queueOf(state)).toEqual([REDIRECT]);
		expect(state.asks.map((ask) => ask.kind)).toEqual(['command']);
	});

	it('the work it asked about ends first → the redirect goes next, ahead of the queue', () => {
		const queuedBehind = run([{ type: 'send', ref: REF, text: 'then the tests' }], {
			start: runningSession(),
		}).state;
		const waiting = run([redirect()], { start: queuedBehind }).state;
		const ended = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Refactored.' }], {
			start: waiting,
		});
		const late = answer(ended.state, true, undefined, 3000);

		expect(ended.effects).toContainEqual(
			expect.objectContaining({ type: 'worker_send', text: REDIRECT }),
		);
		expect(queueOf(ended.state)).toEqual(['then the tests']);
		expect(late.effects).toEqual([]);
	});

	it('the worker exits (clean or crashed) → kept for the next start, no restart', () => {
		for (const error of [null, 'exit 1']) {
			const { state, effects } = run([{ type: 'worker_exited', ref: REF, error }], {
				start: held().state,
			});

			expect(queueOf(state)).toContain(REDIRECT);
			expect(effects.some((effect) => effect.type === 'worker_start')).toBe(false);
		}
	});

	it('a crash with only the held switch waiting → one line says its words are kept', () => {
		const { state, effects } = run([{ type: 'worker_exited', ref: REF, error: 'exit 1' }], {
			start: held().state,
		});

		expect(said(effects)).toEqual(["Couldn't run; your words are kept for the next start."]);
		expect(queueOf(state)).toContain(REDIRECT);
	});

	it('stopped or interrupted by the developer → dropped with the work', () => {
		for (const input of [
			{ type: 'interrupt', ref: REF },
			{ type: 'deactivate', ref: REF },
		] as Input[]) {
			const { state } = run([input], { start: held().state });

			expect(askOf(state)).toBeUndefined();
			expect(queueOf(state)).toEqual([]);
		}
	});

	it('an idle session → simply sent', () => {
		const { state, effects } = run([redirect()], { start: idleSession() });

		expect(askOf(state)).toBeUndefined();
		expect(effects).toContainEqual(
			expect.objectContaining({ type: 'worker_send', text: REDIRECT }),
		);
	});

	it('right after the developer spoke the running request → a quick correction cuts in, no question', () => {
		const spokenTurn = run(
			[{ type: 'send', ref: REF, text: 'refactor the router', isSpoken: true }],
			{ start: idleSession(), at: 1000 },
		).state;
		const { state, effects } = run([redirect()], { start: spokenTurn, at: 5000 });

		expect(askOf(state)).toBeUndefined();
		expect(effects).toContainEqual({ type: 'worker_interrupt', ref: REF, reason: 'follow-up' });
	});

	it('its words finished by a continuation → the waiting instruction grows, still asked once', () => {
		const { state, effects } = run(
			[
				redirect({
					text: `${REDIRECT.slice(0, -1)} and skip the seed.`,
					continues: { rest: 'And skip the seed.' },
				}),
			],
			{ start: held().state, at: 4000 },
		);

		expect(askOf(state)?.text).toBe('Stop that and fix the login bug first and skip the seed.');
		expect(effects).toEqual([]);
	});

	it('a note on either half joins the waiting instruction and goes with it once switched', () => {
		const heldWithNote = run([redirect({ note: 'a' })], { start: runningSession(), at: 1000 });
		const continued = run(
			[
				redirect({
					text: `${REDIRECT.slice(0, -1)} and skip the seed.`,
					continues: { rest: 'And skip the seed.' },
					note: 'b',
				}),
			],
			{ start: heldWithNote.state, at: 4000 },
		);
		const switched = answer(continued.state, true, undefined, 5000);

		expect(askOf(continued.state)?.note).toBe('a\n\nb');
		expect(switched.state.sessions[REF]?.queue[0]?.note).toBe('a\n\nb');
	});

	it('no recorded request → "its current work"', () => {
		const started = run([{ type: 'send', ref: REF, text: 'x' }], { start: idleSession() }).state;
		const blank = {
			...started,
			sessions: { ...started.sessions, [REF]: { ...started.sessions[REF]!, requests: [] } },
		};

		expect(said(run([redirect()], { start: blank }).effects)[0]).toBe(
			'store/main is still on its current work. Stop it and switch? Say yes, or it goes after.',
		);
	});

	it('once delivered, it is an instruction: its report is owed (idle, switched, turn ended, exited)', () => {
		const idle = run([redirect()], { start: idleSession() }).state;
		const switched = answer(held().state, true).state;
		const ended = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Refactored.' }], {
			start: held().state,
		}).state;
		const exited = run([{ type: 'worker_exited', ref: REF, error: null }], {
			start: held().state,
		}).state;

		expect(idle.sessions[REF]?.reportOwed).toBe(true);
		expect(switched.sessions[REF]?.queue[0]?.reportOwed).toBe(true);
		expect(ended.sessions[REF]?.reportOwed).toBe(true);
		expect(exited.sessions[REF]?.queue.at(-1)?.reportOwed).toBe(true);
	});

	it('the question names the current request by its first clause, at most 12 words', () => {
		const withRequest = (text: string) =>
			run([redirect()], {
				start: run([{ type: 'send', ref: REF, text }], { start: idleSession() }).state,
			});

		expect(said(withRequest('refactor the router, then run the tests').effects)[0]).toBe(
			'store/main is still on refactor the router. Stop it and switch? Say yes, or it goes after.',
		);
		expect(
			said(
				withRequest(
					'go through every file in the payments module and rename all the old helpers now',
				).effects,
			)[0],
		).toBe(
			'store/main is still on go through every file in the payments module and rename all. Stop it and switch? Say yes, or it goes after.',
		);
	});

	it('a late lapse after it closed, or a yes too late → no second delivery, no switch', () => {
		const switched = answer(held().state, true);
		const lapseAfter = run([{ type: 'command_expired', askId: askOf(held().state)?.id ?? '' }], {
			start: switched.state,
		});
		const tooLate = answer(held().state, true, undefined, 1000 + 2 * 60_000 + 1);

		expect(lapseAfter.effects).toEqual([]);
		expect(queueOf(lapseAfter.state)).toEqual(queueOf(switched.state));
		expect(tooLate.effects.some((effect) => effect.type === 'worker_interrupt')).toBe(false);
		expect(queueOf(tooLate.state)).toEqual([REDIRECT]);
	});

	it('a turn the session started on its own (none recorded) → a yes still switches', () => {
		const selfStarted = run([{ type: 'turn_started', ref: REF }], {
			start: run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: '' }], {
				start: runningSession(),
			}).state,
		}).state;
		const { effects } = answer(run([redirect()], { start: selfStarted }).state, true);

		expect(effects).toEqual([{ type: 'worker_interrupt', ref: REF, reason: 'follow-up' }]);
	});
});
