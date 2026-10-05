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
			{ kind: 'active' as const },
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
			{ type: 'deactivate', ref: REF },
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
				{ type: 'switch_view', view: { kind: 'active' } },
				{ type: 'turn_ended', ref: REF, costUsd: 0, text: `<spoken>${LONG}</spoken>` },
			],
			{ start: heard },
		);

		expect(effects).toContainEqual(
			expect.objectContaining({ type: 'narrate', isHeld: false, isSpokenAlready: true }),
		);
	});
});

describe('an active session announced', () => {
	const VM1 = { id: 'vm1', host: 'vm1', name: 'Personal' };
	const REMOTE = 'vm1:crew/main';
	const activeState = (extra: Input[] = []): State =>
		run([
			{ type: 'machines', machines: [VM1] },
			{
				type: 'worktrees',
				worktrees: [
					{ ref: REF, label: 'store main', branch: '', cwd: '/w', dirs: [], isPinned: false },
					{ ref: REMOTE, label: 'crew main', branch: '', cwd: '/w', dirs: [], isPinned: false },
				],
			},
			{ type: 'machine_resynced', id: 'vm1', inputs: [] },
			{ type: 'activate', ref: REF },
			{ type: 'activate', ref: REMOTE },
			{ type: 'session_started', ref: REF },
			{ type: 'session_started', ref: REMOTE },
			...extra,
		]).state;

	it('a long question off screen → "<label> needs you: <header>.", no "Your pinned", held', () => {
		const { state, effects } = run([{ type: 'ask_opened', ask: longQuestion('Notes location') }], {
			start: activeState(),
		});

		expect(said(effects)).toEqual(['store main needs you: Notes location.']);
		expect(heldOf(state)).toMatchObject({ kind: 'ask', askId: 'q1' });
	});

	it('on another machine → named with its machine, as any session there', () => {
		const { effects } = run(
			[{ type: 'ask_opened', ask: { ...longQuestion('Notes location'), ref: REMOTE } }],
			{ start: activeState() },
		);

		expect(said(effects)).toEqual(['Personal crew main needs you: Notes location.']);
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
				// A reply to it is for store/main: the kernel reads it as a notification.
				isUpdate: true,
				priority: 'high',
				chime: 'needs',
				waitsForGap: true,
				askId: 'q1',
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

	it("on another session's screen a short question and a permission wait for the meanwhile line, held", () => {
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

		expect(said(asked.effects)).toEqual([]);
		expect(said(permission.effects)).toEqual([]);
		expect(asked.state.meanwhile).toMatchObject([{ ref: REF, kind: 'needs', askId: 'q1' }]);
		expect(permission.state.meanwhile).toMatchObject([{ ref: REF, kind: 'needs', askId: 'a1' }]);
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

	it('the line: an ask in it rings the needs chime and is told; an update alone rings nothing', () => {
		const elsewhere: State = { ...idleSession(), view: { kind: 'session', ref: 'store/wrk1' } };
		const asking = run([{ type: 'play_meanwhile' }], {
			start: open(permissionAsk('a1'), elsewhere).state,
		}).effects;
		const updateOnly = run(
			[
				{ type: 'meanwhile_added', ref: REF, kind: 'done', about: 'tests pass' },
				{ type: 'play_meanwhile' },
			],
			{ start: elsewhere },
		).effects;

		expect(asking[0]).toMatchObject({
			type: 'speak',
			chime: 'needs',
			isAsking: true,
			toldAsks: [{ ref: REF, askId: 'a1' }],
		});
		expect(updateOnly[0]).toMatchObject({ type: 'speak' });
		expect(updateOnly[0]).not.toHaveProperty('chime');
		expect(updateOnly[0]).not.toHaveProperty('toldAsks');
	});

	it('a question that moved on before the line plays → its next question is said', () => {
		const elsewhere: State = { ...idleSession(), view: { kind: 'session', ref: 'store/wrk1' } };
		const twoQuestions: PendingAsk = {
			id: 'q1',
			ref: REF,
			at: 1,
			kind: 'question',
			input: {},
			questions: [
				{ question: 'Postgres or SQLite?', multiSelect: false, options: [] },
				{ question: 'Ship tonight?', multiSelect: false, options: [] },
			],
			answers: { 'Postgres or SQLite?': 'Postgres' },
		};
		const noneOpen: PendingAsk = {
			...twoQuestions,
			id: 'q2',
			answers: { 'Postgres or SQLite?': 'x', 'Ship tonight?': 'y' },
		};

		expect(
			said(
				run([{ type: 'play_meanwhile' }], { start: open(twoQuestions, elsewhere).state }).effects,
			),
		).toEqual(['Meanwhile, store, main asks: Ship tonight?']);

		const empty = run([{ type: 'play_meanwhile' }], {
			start: open(noneOpen, elsewhere).state,
		}).effects;
		expect(said(empty)).toEqual(['Meanwhile, store, main has a question. Switch there?']);
		expect(empty[0]).not.toHaveProperty('toldAsks');
	});

	it('its line said in full, even cut short → answerable at once; a newer ask from it stays held', () => {
		const elsewhere: State = { ...idleSession(), view: { kind: 'session', ref: 'store/wrk1' } };
		const held = open(permissionAsk('a1'), elsewhere).state;

		const tell = (askId: string, start: State): State => {
			const said = run(
				[
					{
						type: 'spoken',
						text: 'Meanwhile, store main wants to run git push.',
						source: 'narrator',
						isUpdate: true,
						isAsking: true,
						refs: [REF],
						toldAsks: [{ ref: REF, askId }],
					},
				],
				{ start },
			).state;
			const lineId = said.spoken.at(-1)?.id ?? '';

			return run([{ type: 'spoken_ended', lineId, isCut: true }], { start: said }).state;
		};

		expect(heldOf(tell('a1', held))).toBeNull();
		expect(heldOf(tell('older', held))).toMatchObject({ kind: 'ask', askId: 'a1' });
	});

	it('replayed on the switch → said with its ask, so answering it on the page stops the line', () => {
		const held = open(longQuestion('Notes location')).state;
		const { effects } = run([{ type: 'switch_view', view: { kind: 'session', ref: REF } }], {
			start: held,
		});

		expect(effects[0]).toMatchObject({
			type: 'speak',
			isAsking: true,
			askId: 'q1',
			askQuestion: 0,
		});
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
				{ type: 'switch_view', view: { kind: 'active' } },
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
		['Mission Control', { kind: 'active' as const }, false],
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
		).toBe('speak/main: Telephony branches pushed.');
		expect(describeAnnouncement({ label: 'speak/main', kind: 'done', about: '  ' })).toBe(
			'speak/main is done.',
		);
		expect(
			describeAnnouncement({
				label: 'speak/main',
				kind: 'done',
				about: describeDoneAbout(
					'Checking whether the detached eval runs finished before deciding which shards to rerun.',
				),
			}),
		).toBe(
			'speak/main: Checking whether the detached eval runs finished before deciding which shards to rerun.',
		);
	});

	it.each([
		[
			'its own last line',
			'Checking whether the detached eval runs finished before deciding.',
			'Checking whether the detached eval runs finished before deciding',
		],
		[
			'a first sentence longer than fourteen words → kept whole',
			'Pushed the telephony branches, opened the pull request, and asked for a review from the team today.',
			'Pushed the telephony branches, opened the pull request, and asked for a review from the team today',
		],
		[
			'several sentences → the whole ones that fit, never one cut in half (note 29)',
			'PR 41 is merged into main. CI is running now, and once it passes I will tag and release v5.7.0 for you.',
			'PR 41 is merged into main',
		],
		[
			'two short sentences → both',
			'Tests pass. The branch is pushed.',
			'Tests pass. The branch is pushed',
		],
		[
			'a version never ends a sentence: "v5.7.0." joins the next one (accepted)',
			'Bumped to v5.7.0. Tests pass.',
			'Bumped to v5.7.0. Tests pass',
		],
		[
			'a file name → unchanged',
			'Fixed voice-out.ts and added a test.',
			'Fixed voice-out.ts and added a test',
		],
		['a decimal → unchanged', 'Coverage is 92.5 percent now.', 'Coverage is 92.5 percent now'],
		[
			'"e.g." does not end the sentence',
			'Pick a short name, e.g. store front or checkout api, for the worktree you are about to make. Then run setup.',
			'Pick a short name, e.g. store front or checkout api, for the worktree you are about to make',
		],
		[
			'a version in the first sentence, a second one over the limit → only the first',
			'Released v5.7.0 to npm. The changelog lists the import wizard, the base table, the check card fixes and the proxy page.',
			'Released v5.7.0 to npm',
		],
		[
			'a seventeen-word first sentence → kept whole',
			'Tagged and released v5.7.0 with the new import wizard, the base table and the check card fixes.',
			'Tagged and released v5.7.0 with the new import wizard, the base table and the check card fixes',
		],
		[
			'a version and a decimal in one sentence → unchanged',
			'The suite now runs in 2.5 seconds, down from nine.',
			'The suite now runs in 2.5 seconds, down from nine',
		],
		[
			'a first sentence of fifteen to twenty-eight words, then a short one → only the first',
			'Pushed the telephony branches, opened the pull request, and asked for a review from the team today. Done.',
			'Pushed the telephony branches, opened the pull request, and asked for a review from the team today',
		],
		['voice tags dropped', '[relieved] Tests pass now.', 'Tests pass now'],
		['one word → nothing', 'Done.', null],
		['nothing at all', null, null],
	])('%s', (_, said, expected) => expect(describeDoneAbout(said)).toBe(expected));

	it('a first sentence of exactly twenty-eight words → kept whole, no "…"', () =>
		expect(
			describeDoneAbout(
				'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20 w21 w22 w23 w24 w25 w26 w27 w28.',
			),
		).toBe(
			'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20 w21 w22 w23 w24 w25 w26 w27 w28',
		));

	it('a first sentence of twenty-nine words → its first twenty-eight, with "…"', () =>
		expect(
			describeDoneAbout(
				'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20 w21 w22 w23 w24 w25 w26 w27 w28 w29. Then more.',
			),
		).toBe(
			'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20 w21 w22 w23 w24 w25 w26 w27 w28…',
		));
});

describe('an answer settles the waiting update of its session', () => {
	const elsewhere = (): State => ({
		...idleSession(),
		view: { kind: 'session', ref: 'store/wrk1' },
	});
	const asked = (): State =>
		run(
			[
				{
					type: 'ask_opened',
					ask: {
						id: 'q1',
						ref: REF,
						at: 1,
						kind: 'question',
						input: {},
						questions: [
							{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [] },
						],
					},
				},
				{ type: 'meanwhile_added', ref: REF, kind: 'done', about: 'tests pass' },
			],
			{ start: elsewhere() },
		).state;
	const answers: Input[] = [
		{ type: 'decline_question', askId: 'q1' },
		{ type: 'answer_question', askId: 'q1', answers: { 'Which one?': 'A' } },
	];

	for (const answer of answers) {
		it(`${answer.type} → nothing waits for it`, () => {
			const start = asked();

			expect(start.meanwhile.map((item) => item.ref)).toEqual([REF]);
			expect(run([answer], { start }).state.meanwhile).toEqual([]);
		});
	}
});

describe('a held line whose start the meanwhile line said (debug note 42)', () => {
	const FIRST = 'All forty payment tests pass on the retry branch.';
	const SECOND = 'The backoff now starts at two hundred milliseconds and doubles each try.';
	const elsewhere = (text: string, isAsking = false): State =>
		holdLine({
			state: { ...idleSession(), view: { kind: 'session', ref: 'store/wrk1' } },
			ref: REF,
			content: { kind: 'line', text, isAsking },
			stamped: { id: 'h1', at: 1 },
		});

	const hear = (start: State, text: string, isCut = false): State => {
		const spoken = run(
			[{ type: 'spoken', text, source: 'narrator', isUpdate: true, refs: [REF] }],
			{ start },
		).state;
		const lineId = spoken.spoken.at(-1)?.id ?? '';

		return run([{ type: 'spoken_ended', lineId, isCut }], { start: spoken }).state;
	};

	const lineFor = (held: string) =>
		`Meanwhile, store, main said: ${describeDoneAbout(held) ?? ''}.`;

	it('the line said all of it → nothing is held, so a switch says nothing again', () =>
		expect(heldOf(hear(elsewhere(FIRST), lineFor(FIRST)))).toBeNull());

	it('the line said its start → only the rest is held', () => {
		const held = `${FIRST} ${SECOND} ${SECOND}`;
		const state = hear(elsewhere(held), lineFor(held));

		expect(heldOf(state)).toMatchObject({ kind: 'line', text: `${SECOND} ${SECOND}` });
	});

	it('the switch there says only the rest; after a line that said all of it, nothing', () => {
		const held = `${FIRST} ${SECOND} ${SECOND}`;
		const switchThere = (start: State) =>
			run([{ type: 'switch_view', view: { kind: 'session', ref: REF } }], { start }).effects;

		expect(said(switchThere(hear(elsewhere(held), lineFor(held))))).toEqual([
			`${SECOND} ${SECOND.slice(0, -1)}.`,
		]);
		expect(said(switchThere(hear(elsewhere(FIRST), lineFor(FIRST))))).toEqual([]);
	});

	it('all of it said, with earlier updates on the page → nothing held: the page shows them', () => {
		const twice = holdLine({
			state: elsewhere(FIRST),
			ref: REF,
			content: { kind: 'line', text: FIRST, isAsking: false },
			stamped: { id: 'h2', at: 2 },
		});

		expect(heldOf(twice)).toMatchObject({ missed: 1 });
		expect(heldOf(hear(twice, lineFor(FIRST)))).toBeNull();
	});

	it('a first sentence too long to say whole → the line is kept whole, never replayed mid-sentence', () => {
		const long = `${'The retry client now backs off and '.repeat(8).trim()} stops.`;

		expect(describeDoneAbout(long)?.endsWith('…')).toBe(true);
		expect(heldOf(hear(elsewhere(long), lineFor(long)))).toMatchObject({ text: long });
	});

	it('a line held after the meanwhile line was said → kept whole: the line was not about it', () => {
		const spoken = run(
			[{ type: 'spoken', text: lineFor(FIRST), source: 'narrator', isUpdate: true, refs: [REF] }],
			{ start: elsewhere(FIRST) },
		).state;
		const line = spoken.spoken.at(-1);
		const newer = holdLine({
			state: spoken,
			ref: REF,
			content: { kind: 'line', text: FIRST, isAsking: false },
			stamped: { id: 'h3', at: (line?.at ?? 0) + 1 },
		});
		const ended = run([{ type: 'spoken_ended', lineId: line?.id ?? '', isCut: false }], {
			start: newer,
		}).state;

		expect(heldOf(ended)).toMatchObject({ id: 'h3', text: FIRST });
	});

	it('a question, a line cut short, or a line that said something else → held as it was', () => {
		expect(heldOf(hear(elsewhere(FIRST, true), lineFor(FIRST)))).toMatchObject({ text: FIRST });
		expect(heldOf(hear(elsewhere(FIRST), lineFor(FIRST), true))).toMatchObject({ text: FIRST });
		expect(heldOf(hear(elsewhere(FIRST), 'Meanwhile, store, main finished.'))).toMatchObject({
			text: FIRST,
		});
	});
});
