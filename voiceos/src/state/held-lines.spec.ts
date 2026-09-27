import { describe, expect, it } from 'bun:test';
import type { Input, PendingAsk, State } from '../shared/protocol.js';
import type { Effect } from './reducer.js';
import { REF, idleSession, permissionAsk, run, runningSession } from '../../test/support/reduce.js';
import { describeAnnouncement, describeHeldLine, isShortLine } from './held-lines.js';

const LONG =
	'The notes panel is built, the reviewers signed off, and it is committed on the voice-os branch.';
const tagged = (text: string, isAsking = false): Input => ({
	type: 'assistant_text',
	ref: REF,
	text: `<spoken${isAsking ? ' asks' : ''}>${text}</spoken>\nDetails.`,
});
const onScreen = (state: State): State => ({ ...state, view: { kind: 'session', ref: REF } });
const said = (effects: Effect[]) =>
	effects.flatMap((effect) => (effect.type === 'speak' ? [effect.text] : []));
const heldOf = (state: State) => state.sessions[REF]?.heldLine;
const longQuestion = (header?: string): PendingAsk => ({
	id: 'q1',
	ref: REF,
	at: 1,
	kind: 'question',
	input: {},
	questions: [
		{
			question:
				'Where should a workspace keep its notes: in the Voice OS folder or in a file inside the project?',
			...(header ? { header } : {}),
			multiSelect: false,
			options: [{ label: 'Voice OS folder' }, { label: 'Project file' }],
		},
	],
});

describe('the words', () => {
	it.each([
		['one two three four five six seven eight nine ten eleven twelve', true],
		['one two three four five six seven eight nine ten eleven twelve thirteen', false],
		['Tests pass. Pushed.', true],
		['Push it now?', true],
	])('%p short → %p', (text, expected) => expect(isShortLine(text)).toBe(expected));

	it('announcements: done, needs you with or without what about', () => {
		expect(describeAnnouncement({ label: 'crew research', kind: 'done' })).toBe(
			'crew research is done.',
		);
		expect(
			describeAnnouncement({
				label: 'crew main',
				kind: 'needs',
				about: 'where notes should live.',
			}),
		).toBe('crew main needs you: where notes should live.');
		expect(describeAnnouncement({ label: 'crew main', kind: 'needs', about: ' ' })).toBe(
			'crew main needs you.',
		);
	});

	it('a held line: updates missed, and still working', () => {
		expect(describeHeldLine({ text: 'Notes are built.', missed: 0, isWorking: false })).toBe(
			'Notes are built.',
		);
		expect(describeHeldLine({ text: 'Tests pass', missed: 1, isWorking: true })).toBe(
			'Tests pass — still working. One earlier update is on the page.',
		);
		expect(describeHeldLine({ text: 'Done!', missed: 2, isWorking: false })).toBe(
			'Done. Two earlier updates are on the page.',
		);
	});
});

describe('held while the developer looks elsewhere', () => {
	it('off screen a line is held, not said; each newer one replaces it and counts', () => {
		const first = run([tagged('Plan approved; building now.')], { start: runningSession() });
		const second = run([tagged(LONG)], { start: first.state });

		expect(said(first.effects)).toEqual([]);
		expect(heldOf(first.state)).toMatchObject({
			kind: 'line',
			text: 'Plan approved; building now.',
			missed: 0,
		});
		expect(heldOf(second.state)).toMatchObject({ text: LONG, missed: 1 });
	});

	it('on screen it is said as always, and nothing is held', () => {
		const { state, effects } = run([tagged(LONG)], { start: onScreen(runningSession()) });

		expect(said(effects)).toEqual([LONG]);
		expect(heldOf(state)).toBeNull();
	});

	it('switching there plays it once (still working while it works), then it is gone', () => {
		const held = run([tagged('Plan approved.'), tagged(LONG)], { start: runningSession() }).state;
		const shown = run([{ type: 'switch_view', view: { kind: 'session', ref: REF } }], {
			start: held,
		});
		const again = run([{ type: 'switch_view', view: { kind: 'session', ref: REF } }], {
			start: shown.state,
		});

		expect(shown.effects).toEqual([
			{
				type: 'speak',
				text: `${LONG.slice(0, -1)} — still working. One earlier update is on the page.`,
				source: 'narrator',
				ref: REF,
				priority: 'high',
				isOwed: true,
				isReply: true,
			},
		]);
		expect(heldOf(shown.state)).toBeNull();
		expect(again.effects).toEqual([]);
	});

	it('switching to Mission Control or another session leaves it held', () => {
		const held = run([tagged(LONG)], { start: runningSession() }).state;

		for (const view of [
			{ kind: 'grid' as const },
			{ kind: 'session' as const, ref: 'store/wrk1' },
		]) {
			const { state, effects } = run([{ type: 'switch_view', view }], { start: held });

			expect(effects).toEqual([]);
			expect(heldOf(state)).not.toBeNull();
		}
	});

	it('words sent to it, an interrupt, a stop, or the worker exiting clear it', () => {
		const held = run([tagged(LONG)], { start: runningSession() }).state;

		for (const input of [
			{ type: 'send', ref: REF, text: 'also run the linter' },
			{ type: 'interrupt', ref: REF },
			{ type: 'stop_session', ref: REF },
			{ type: 'worker_exited', ref: REF, error: null },
			{ type: 'worker_exited', ref: REF, error: 'exit 1' },
		] as Input[]) {
			expect(heldOf(run([input], { start: held }).state)).toBeNull();
		}
	});

	it('held_line_heard clears only the line it names', () => {
		const held = run([tagged(LONG)], { start: runningSession() }).state;
		const id = heldOf(held)?.id ?? '';

		expect(
			heldOf(run([{ type: 'held_line_heard', ref: REF, id }], { start: held }).state),
		).toBeNull();
		expect(
			heldOf(run([{ type: 'held_line_heard', ref: REF, id: 'older' }], { start: held }).state),
		).not.toBeNull();
	});

	it('the turn ends on a held line → the narrator is told it was held, not said', () => {
		const { effects } = run(
			[
				{ type: 'text_delta', ref: REF, text: `<spoken>${LONG}</spoken>` },
				{ type: 'turn_ended', ref: REF, costUsd: 0, text: `<spoken>${LONG}</spoken>\nDetails.` },
			],
			{ start: runningSession() },
		);

		expect(effects).toContainEqual(
			expect.objectContaining({ type: 'narrate', isHeld: true, isSpokenAlready: false }),
		);
	});

	it('heard on screen, then the developer switched away → the turn end knows it was said', () => {
		const heard = run([{ type: 'text_delta', ref: REF, text: `<spoken>${LONG}</spoken>` }], {
			start: onScreen(runningSession()),
		}).state;
		const { effects } = run(
			[
				{ type: 'switch_view', view: { kind: 'grid' } },
				{ type: 'turn_ended', ref: REF, costUsd: 0, text: `<spoken>${LONG}</spoken>` },
			],
			{ start: heard },
		);

		expect(effects).toContainEqual(
			expect.objectContaining({ type: 'narrate', isHeld: false, isSpokenAlready: true }),
		);
	});
});

describe('asks off screen', () => {
	const open = (ask: PendingAsk, start = idleSession()) =>
		run([{ type: 'ask_opened', ask }], { start });

	it('a long question is announced with its header and held; switching reads the live ask', () => {
		const { state, effects } = open(longQuestion('Notes location'));
		const shown = run([{ type: 'switch_view', view: { kind: 'session', ref: REF } }], {
			start: state,
		});

		expect(effects).toEqual([
			{
				type: 'speak',
				text: 'store/main needs you: Notes location.',
				source: 'alert',
				ref: REF,
				priority: 'high',
				chime: 'needs',
			},
		]);
		expect(heldOf(state)).toMatchObject({ kind: 'ask', askId: 'q1' });
		expect(said(shown.effects)[0]).toContain('Where should a workspace keep its notes');
		expect(shown.effects[0]).toMatchObject({ isAsking: true });
	});

	it('no header → the question\'s first words; a plan → "a plan to approve"', () => {
		const plan: PendingAsk = {
			id: 'p1',
			ref: REF,
			at: 1,
			kind: 'plan',
			input: {},
			plan: 'Do X.',
		} as PendingAsk;

		expect(said(open(longQuestion()).effects)).toEqual([
			'store/main needs you: Where should a workspace keep its.',
		]);
		expect(said(open(plan).effects)).toEqual(['store/main needs you: a plan to approve.']);
	});

	it('a short question, a permission, or anything on screen → said as always, nothing held', () => {
		const short = {
			...longQuestion(),
			questions: [{ question: 'Postgres or SQLite?', multiSelect: false, options: [] }],
		} as PendingAsk;

		for (const result of [
			open(short),
			open(permissionAsk('a1')),
			open(longQuestion(), onScreen(idleSession())),
		]) {
			expect(heldOf(result.state)).toBeNull();
			expect(result.effects[0]).toMatchObject({ isAsking: true, source: 'alert' });
		}
	});

	it('answered or closed before the switch → nothing replays', () => {
		const held = open(longQuestion('Notes location')).state;
		const closed = run([{ type: 'ask_closed', askId: 'q1' }], { start: held }).state;

		expect(heldOf(closed)).toBeNull();
		expect(
			run([{ type: 'switch_view', view: { kind: 'session', ref: REF } }], { start: closed })
				.effects,
		).toEqual([]);
	});
});

describe('a held question replayed', () => {
	it('is said as a question the developer has now heard: asked aloud and owed', () => {
		const held = run(
			[
				tagged(
					'Should the backoff cap stay at thirty seconds, or follow the provider limit we found?',
					true,
				),
			],
			{
				start: runningSession(),
			},
		).state;
		const { effects } = run([{ type: 'switch_view', view: { kind: 'session', ref: REF } }], {
			start: held,
		});

		expect(effects[0]).toMatchObject({ type: 'speak', isAsking: true, isOwed: true });
	});
});
