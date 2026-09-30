import { describe, expect, it } from 'bun:test';
import type { Input, PendingAsk, State } from '../shared/protocol.js';
import type { Effect } from './reducer.js';
import { REF, idleSession, permissionAsk, run, runningSession } from '../../test/support/reduce.js';
import { findLastAskedAloud } from '../tools/asked-aloud.js';
import {
	decideTurnLine,
	describeAnnouncement,
	describeDoneAbout,
	describeHeldLine,
	holdLine,
	isOnAnotherSession,
	isShortLine,
	type TurnLineDecision,
} from './held-lines.js';

const LONG =
	'The notes panel is built, the reviewers signed off, and it is committed on the voice-os branch.';
// 105 words, its question last: past the word cap narrator summaries keep.
const LONG_ASKING_LINE = `${'The parser now handles nested quotes and escaped brackets correctly everywhere. '.repeat(9).trim()} Should I push the branch now?`;
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
		// A tag is no word: twelve words and a tag are still short.
		['one two three four five six. [laughs] seven eight nine ten eleven twelve', true],
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

	it('a held 105-word line → replayed whole, its closing question kept', () =>
		expect(describeHeldLine({ text: LONG_ASKING_LINE, missed: 0, isWorking: false })).toBe(
			`${LONG_ASKING_LINE.replace(/\?$/, '')}.`,
		));
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

	it('on Mission Control a short question or a permission, or anything on screen → said as always', () => {
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

	it("on another session's screen a short question and a permission are announced and held too", () => {
		const elsewhere: State = {
			...idleSession(),
			view: { kind: 'session', ref: 'store/wrk1' },
		};
		const short = {
			...longQuestion(),
			questions: [{ question: 'Postgres or SQLite?', multiSelect: false, options: [] }],
		} as PendingAsk;
		const asked = open(short, elsewhere);
		const permission = open(permissionAsk('a1'), elsewhere);

		expect(said(asked.effects)).toEqual(['store/main needs you: Postgres or SQLite.']);
		expect(said(permission.effects)).toEqual(['store/main needs you: approval to run git push.']);
		expect(heldOf(asked.state)).toMatchObject({ kind: 'ask', askId: 'q1' });
		expect(heldOf(permission.state)).toMatchObject({ kind: 'ask', askId: 'a1' });
		expect(
			said(
				run([{ type: 'switch_view', view: { kind: 'session', ref: REF } }], {
					start: permission.state,
				}).effects,
			),
		).toEqual(['store/main wants to run git push. Allow?']);
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

describe('a question or plan the session already asked in its own line', () => {
	const ASKED = 'One choice for you: should needs you get its own chime?';
	const question = (id = 'q1', ref = REF): PendingAsk => ({
		id,
		ref,
		at: 1,
		kind: 'question',
		input: {},
		questions: [
			{
				question: 'Chimes: which sounds do you want?',
				header: 'Chimes',
				multiSelect: false,
				options: [{ label: 'One' }],
			},
		],
	});
	const plan: PendingAsk = {
		id: 'p1',
		ref: REF,
		at: 1,
		kind: 'plan',
		input: {},
		plan: 'Do X.',
	} as PendingAsk;
	const heard = (ref = REF): Input => ({ type: 'spoken', text: ASKED, source: 'narrator', ref });
	// The session on screen says its line, and the developer hears it start.
	const saidAndHeard = (start = onScreen(runningSession())) =>
		run([tagged(ASKED, true), heard()], { start }).state;
	const open = (ask: PendingAsk, start: State) =>
		run([{ type: 'ask_opened', ask }], { start, at: 5_000 });

	it('heard just before a question or a plan opens → Voice OS says nothing more; that line now counts as asked', () => {
		for (const ask of [question(), plan]) {
			const { state, effects } = open(ask, saidAndHeard());

			expect(said(effects)).toEqual([]);
			expect(state.asks.map((pending) => pending.id)).toEqual([ask.id]);
			expect(state.sessions[REF]?.status).toBe('blocked');
			expect(state.spoken.at(-1)).toMatchObject({ text: ASKED, isAsking: true });
		}
	});

	it('a long line that asked, heard just before the question opens → not asked again', () => {
		const heardLong: Input = {
			type: 'spoken',
			text: LONG_ASKING_LINE,
			source: 'narrator',
			ref: REF,
		};
		const start = run([tagged(LONG_ASKING_LINE, true), heardLong], {
			start: onScreen(runningSession()),
		}).state;
		const { effects } = open(question(), start);

		expect(said(effects)).toEqual([]);
	});

	it('a long line that asked, streamed in chunks, then heard just before the question opens → not asked again', () => {
		const whole = `<spoken asks>${LONG_ASKING_LINE}</spoken>\nDetails.`;
		const chunks = whole.match(/[\s\S]{1,40}/g) ?? [];
		const heardLong: Input = {
			type: 'spoken',
			text: LONG_ASKING_LINE,
			source: 'narrator',
			ref: REF,
		};
		const start = run(
			[
				...chunks.map((text): Input => ({ type: 'text_delta', ref: REF, text })),
				tagged(LONG_ASKING_LINE, true),
				heardLong,
			],
			{ start: onScreen(runningSession()) },
		).state;
		const { effects } = open(question(), start);

		expect(said(effects)).toEqual([]);
	});

	it('the session did something else after its line, or the line has not played yet → asked as always', () => {
		const afterTool = run([{ type: 'tool', ref: REF, name: 'Read', summary: 'read a file' }], {
			start: saidAndHeard(),
		}).state;
		const notYetPlayed = run([tagged(ASKED, true)], { start: onScreen(runningSession()) }).state;

		for (const start of [afterTool, notYetPlayed]) {
			expect(said(open(question(), start).effects)).toEqual([expect.stringContaining('asks:')]);
		}
	});

	it('a line from the turn before → asked as always', () => {
		const lastTurn = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: '' }], {
			start: saidAndHeard(),
		}).state;
		const busyAgain = run([{ type: 'send', ref: REF, text: 'go on' }], { start: lastTurn }).state;

		expect(said(open(question(), busyAgain).effects)).toHaveLength(1);
	});

	it('a permission right after a line → asked as always', () =>
		expect(said(open(permissionAsk('a1'), saidAndHeard()).effects)).toHaveLength(1));

	it('the developer left before hearing it: the line held becomes the question, replayed as it', () => {
		const asked = open(question(), saidAndHeard()).state;
		const left = run(
			[
				{ type: 'switch_view', view: { kind: 'grid' } },
				{ type: 'line_held', ref: REF, text: ASKED, isAsking: true },
			],
			{ start: asked },
		).state;
		const back = run([{ type: 'switch_view', view: { kind: 'session', ref: REF } }], {
			start: left,
		});

		expect(heldOf(left)).toMatchObject({ kind: 'ask', askId: 'q1' });
		expect(said(back.effects)[0]).toContain('Chimes: which sounds do you want?');
	});

	it('off screen, a short question said in full → the line held with it is not told again', () => {
		const held = run([tagged('Push it now?', true)], { start: runningSession() }).state;
		const short = {
			...question(),
			questions: [{ question: 'Push it now?', multiSelect: false, options: [] }],
		} as PendingAsk;
		const { state, effects } = open(short, held);

		expect(said(effects)).toHaveLength(1);
		expect(heldOf(state)).toBeNull();
	});

	it('two sessions waiting → the one whose own line asked is the one asked aloud', () => {
		const otherAsked = run(
			[
				{ type: 'ask_opened', ask: permissionAsk('a1', 'store/wrk1') },
				{
					type: 'spoken',
					text: 'store/wrk1 wants to push. Allow?',
					source: 'alert',
					ref: 'store/wrk1',
					isAsking: true,
				},
				tagged(ASKED, true),
				heard(),
			],
			{ start: onScreen(runningSession()), at: 1_000 },
		).state;
		const { state } = open(question(), otherAsked);

		expect(
			findLastAskedAloud({ spoken: state.spoken, waitingRefs: [REF, 'store/wrk1'], now: 6_000 }),
		).toMatchObject({ ref: REF, text: ASKED });
	});

	it('an older line that started playing after the asking one was written is not it → asked as always', () => {
		const older = run(
			[
				tagged('Checking the logs first.'),
				{ type: 'tool', ref: REF, name: 'Read', summary: 'read a file' },
				tagged(ASKED, true),
				{ type: 'spoken', text: 'Checking the logs first.', source: 'narrator', ref: REF },
			],
			{ start: onScreen(runningSession()) },
		).state;

		expect(said(open(question(), older).effects)).toHaveLength(1);
	});

	it('a second question right after the first, with no new line → Voice OS asks it', () => {
		const first = open(question(), saidAndHeard()).state;
		const answered = run(
			[
				{
					type: 'answer_question',
					askId: 'q1',
					answers: { 'Chimes: which sounds do you want?': 'One' },
				},
			],
			{ start: first },
		).state;
		const second = run([{ type: 'ask_opened', ask: question('q2') }], {
			start: answered,
			at: 8_000,
		});

		expect(said(second.effects)).toHaveLength(1);
	});

	it('a line starting "asks:" is still the line that asked', () => {
		const asksLine = run(
			[
				tagged('asks: should needs you get its own chime?', true),
				{
					type: 'spoken',
					text: 'Should needs you get its own chime?',
					source: 'narrator',
					ref: REF,
				},
			],
			{ start: onScreen(runningSession()) },
		).state;

		expect(said(open(question(), asksLine).effects)).toEqual([]);
	});

	it('heard more than 30 s before the question opened → asked as always', () => {
		const long = run([{ type: 'ask_opened', ask: question() }], {
			start: saidAndHeard(),
			at: 40_000,
		});

		expect(said(long.effects)).toHaveLength(1);
	});

	it('a question with more to answer, answered by voice → the next one is still said', () => {
		const two = {
			...question(),
			questions: [
				{ question: 'First?', header: 'One', multiSelect: false, options: [] },
				{ question: 'Second?', header: 'Two', multiSelect: false, options: [] },
			],
		} as PendingAsk;
		const asked = open(two, saidAndHeard()).state;
		const { effects } = run(
			[{ type: 'answer_question', askId: 'q1', answers: { 'First?': 'yes' }, isSpoken: true }],
			{ start: asked },
		);

		expect(said(effects)[0]).toContain('Second?');
	});
});

describe('decideTurnLine', () => {
	const base = {
		isShown: false,
		isShort: false,
		isHeldAnnounced: false,
		hasBackgroundAgents: false,
		needsUser: false,
		isOnAnotherSession: true,
	};

	const cases: [string, Partial<typeof base>, TurnLineDecision][] = [
		['on screen', { isShown: true, isHeldAnnounced: true }, { kind: 'say' }],
		['short, off screen', { isShort: true }, { kind: 'say' }],
		['long report', {}, { kind: 'hold', announce: 'done' }],
		[
			'background sub-agents still work',
			{ hasBackgroundAgents: true },
			{ kind: 'hold', announce: null },
		],
		[
			'after a report already announced',
			{ isHeldAnnounced: true },
			{ kind: 'hold', announce: null },
		],
		[
			'short, after a report already announced',
			{ isShort: true, isHeldAnnounced: true },
			{ kind: 'hold', announce: null },
		],
		['a question', { needsUser: true, isHeldAnnounced: true }, { kind: 'hold', announce: 'needs' }],
		[
			'a question while background sub-agents work',
			{ needsUser: true, hasBackgroundAgents: true },
			{ kind: 'hold', announce: 'needs' },
		],
		[
			'short, while background sub-agents work',
			{ isShort: true, hasBackgroundAgents: true },
			{ kind: 'say' },
		],
		[
			'a short question over another session',
			{ needsUser: true, isShort: true },
			{ kind: 'hold', announce: 'needs' },
		],
		[
			'a short question on Mission Control',
			{ needsUser: true, isShort: true, isOnAnotherSession: false },
			{ kind: 'say' },
		],
	];

	it.each(cases)('%s', (_, params, expected) =>
		expect(decideTurnLine({ ...base, ...params })).toEqual(expected),
	);
});

describe('holdLine after an announced report', () => {
	const stamped = (id: string) => ({ id, at: 1 });

	const announced = (): State => {
		const held = holdLine({
			state: idleSession(),
			ref: REF,
			content: { kind: 'line', text: LONG, isAsking: false },
			stamped: stamped('h1'),
		});

		return run([{ type: 'held_line_announced', ref: REF, id: 'h1' }], { start: held }).state;
	};

	it('a short afterword leaves the report held, counted as one more update on the page', () => {
		const state = holdLine({
			state: announced(),
			ref: REF,
			content: { kind: 'line', text: 'Covered in the answer above.', isAsking: false },
			stamped: stamped('h2'),
		});

		expect(heldOf(state)).toMatchObject({ id: 'h1', text: LONG, missed: 1, isAnnounced: true });
	});

	it('a longer line or a question replaces it and keeps it announced', () => {
		for (const content of [
			{ kind: 'line' as const, text: `${LONG} And the docs are updated too.`, isAsking: false },
			{ kind: 'line' as const, text: 'Push it now?', isAsking: true },
		]) {
			expect(
				heldOf(holdLine({ state: announced(), ref: REF, content, stamped: stamped('h2') })),
			).toMatchObject({ id: 'h2', missed: 1, isAnnounced: true });
		}
	});

	it('held_line_announced for a line no longer held changes nothing', () => {
		const held = holdLine({
			state: idleSession(),
			ref: REF,
			content: { kind: 'line', text: LONG, isAsking: false },
			stamped: stamped('h1'),
		});
		const state = run([{ type: 'held_line_announced', ref: REF, id: 'old' }], {
			start: held,
		}).state;

		expect(heldOf(state)).toMatchObject({ id: 'h1', isAnnounced: false });
	});
});

describe('a held line replayed while background sub-agents work', () => {
	it('says "still working"', () => {
		const state = run(
			[
				{
					type: 'subagent_started',
					ref: REF,
					taskId: 't1',
					agentType: null,
					description: 'research',
					isBackground: true,
				},
				tagged(LONG),
				{ type: 'switch_view', view: { kind: 'session', ref: REF } },
			],
			{ start: idleSession() },
		);

		expect(said(state.effects)[0]).toContain('still working');
	});
});

describe('isOnAnotherSession', () => {
	it.each([
		['Mission Control', { kind: 'grid' as const }, false],
		['the session itself', { kind: 'session' as const, ref: REF }, false],
		['another session', { kind: 'session' as const, ref: 'store/wrk1' }, true],
	])('%s → %p', (_, view, expected) =>
		expect(isOnAnotherSession({ ...idleSession(), view }, REF)).toBe(expected),
	);
});

describe('what a "done" names', () => {
	it('the announcement: with what finished, or bare when nothing says it', () => {
		expect(
			describeAnnouncement({
				label: 'speak/main',
				kind: 'done',
				about: 'Telephony branches pushed.',
			}),
		).toBe('speak/main is done: Telephony branches pushed.');
		expect(describeAnnouncement({ label: 'speak/main', kind: 'done', about: '  ' })).toBe(
			'speak/main is done.',
		);
		expect(
			describeAnnouncement({
				label: 'speak/main',
				kind: 'done',
				about: describeDoneAbout({
					topic: null,
					isTopicPinned: false,
					asked: 'can you give me full context so i can copy it over',
				}),
			}),
		).toBe('speak/main is done: can you give me full context so i…');
	});

	it.each([
		[
			'a topic written for the work',
			{ topic: 'Search box on the right', isTopicPinned: false, asked: 'move it' },
			'Search box on the right',
		],
		[
			'a pinned topic → the request instead',
			{ topic: 'Voice OS', isTopicPinned: true, asked: 'push everything to the existing branches' },
			'push everything to the existing branches',
		],
		[
			'a reply too short to say anything → nothing',
			{ topic: null, isTopicPinned: false, asked: 'no' },
			null,
		],
		[
			'a long request → its first eight words',
			{
				topic: null,
				isTopicPinned: false,
				asked: 'can you give me full context so i can copy it to a different session',
			},
			'can you give me full context so i…',
		],
		[
			'trailing punctuation dropped',
			{ topic: null, isTopicPinned: false, asked: 'push the telephony branches.' },
			'push the telephony branches',
		],
		['nothing at all', { topic: null, isTopicPinned: false, asked: null }, null],
		['two words → nothing', { topic: null, isTopicPinned: false, asked: 'push it' }, null],
		[
			'three words → said',
			{ topic: null, isTopicPinned: false, asked: 'push it now' },
			'push it now',
		],
		[
			'punctuation where the cap cuts → dropped before the ellipsis',
			{
				topic: null,
				isTopicPinned: false,
				asked: 'first the api, then the app, then the docs please',
			},
			'first the api, then the app, then the…',
		],
	])('%s', (_, params, expected) => expect(describeDoneAbout(params)).toBe(expected));
});
