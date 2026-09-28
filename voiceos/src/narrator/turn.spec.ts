import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory } from '../memory/journal.js';
import { Store } from '../state/store.js';
import type { Narration } from './prompt.js';
import type { TopicInput } from './topic.js';
import { createAsideNarrator, createTurnNarrator, settleOwedReport } from './turn.js';

// What the topic writer returns; by default it keeps the topic it was given.
type TopicReply = (input: TopicInput) => string | null;

const createHarness = (
	narration: Narration,
	topicReply: TopicReply = (input) => input.topic,
	aboutReply: string | null = null,
) => {
	const store = new Store();

	store.dispatch({
		type: 'worktrees',
		worktrees: [
			{
				ref: 'checkout-api/main',
				label: 'checkout-api/main',
				branch: '',
				cwd: '/w',
				dirs: [],
				isPinned: false,
			},
		],
	});

	const spoken: string[] = [];
	const asking: boolean[] = [];
	const journalDir = mkdtempSync(join(tmpdir(), 'voiceos-turn-'));
	const seen: { focused: boolean }[] = [];
	const said: { priority: string; isOwed: boolean }[] = [];
	const topicCalls: TopicInput[] = [];
	const handle = createTurnNarrator({
		store,
		narrate: async (input) => {
			seen.push({ focused: input.focused });

			return narration;
		},
		writeTopic: async (input) => {
			topicCalls.push(input);

			return { topic: topicReply(input), about: aboutReply };
		},
		say: ({ text, isAsking, priority, isOwed }) => {
			spoken.push(text);
			asking.push(isAsking);
			said.push({ priority, isOwed: Boolean(isOwed) });
		},
		journalDir,
		readGitHead: async () => 'abc1234',
		now: () => new Date('2026-09-25T02:00:00Z'),
	});

	return { store, spoken, asking, said, journalDir, seen, handle, topicCalls };
};

describe('turn narrator', () => {
	it('question at the end → needs you, spoken, topic set, journaled with HEAD', async () => {
		const harness = createHarness({
			speak: true,
			needs_user: true,
			priority: 'high',
			text: 'checkout api, main asks: deploy to staging?',
			topic: 'Checkout retry backoff',
		});
		await harness.handle({
			type: 'narrate',
			ref: 'checkout-api/main',
			text: 'Backoff added. Deploy to staging?',
			asked: 'add backoff',
			isOwed: false,
			spoken: null,
			isSpokenAlready: false,
			isHeld: false,
			hasBackgroundAgents: false,
		});

		expect(harness.store.state.sessions['checkout-api/main']).toMatchObject({
			needsUser: { text: 'checkout api, main asks: deploy to staging?' },
			topic: 'Checkout retry backoff',
		});
		expect(harness.spoken).toEqual(['checkout api, main asks: deploy to staging?']);
		expect(harness.asking).toEqual([true]);
		expect(
			readHistory(harness.journalDir, { ref: 'checkout-api/main', query: null, limit: 5 }),
		).toEqual([
			{
				ts: '2026-09-25T02:00:00.000Z',
				ref: 'checkout-api/main',
				asked: 'add backoff',
				did: 'checkout api, main asks: deploy to staging?',
				costUsd: 0,
				head: 'abc1234',
			},
		]);
	});

	it('finished work spoken → a report, not a question: a bare yes after it is not for this session', async () => {
		const harness = createHarness({
			speak: true,
			needs_user: false,
			priority: 'normal',
			text: 'checkout api, main: tests pass.',
			topic: null,
		});
		await harness.handle({
			type: 'narrate',
			ref: 'checkout-api/main',
			text: 'All 96 tests pass.',
			asked: 'run the tests',
			isOwed: false,
			spoken: null,
			isSpokenAlready: false,
			isHeld: false,
			hasBackgroundAgents: false,
		});
		expect(harness.spoken).toEqual(['checkout api, main: tests pass.']);
		expect(harness.asking).toEqual([false]);
	});

	it('silent progress → nothing spoken, still journaled from the text itself', async () => {
		const harness = createHarness({
			speak: false,
			needs_user: false,
			priority: 'low',
			text: '',
			topic: null,
		});
		await harness.handle({
			type: 'narrate',
			ref: 'checkout-api/main',
			text: 'Still running the suite. More soon.',
			asked: null,
			isOwed: false,
			spoken: null,
			isSpokenAlready: false,
			isHeld: false,
			hasBackgroundAgents: false,
		});

		expect(harness.spoken).toEqual([]);
		expect(readHistory(harness.journalDir, { ref: null, query: null, limit: 5 })[0]?.did).toBe(
			'Still running the suite.',
		);
	});

	it('the viewed session is marked focused for the narrator', async () => {
		const harness = createHarness({
			speak: false,
			needs_user: false,
			priority: 'low',
			text: '',
			topic: null,
		});
		harness.store.dispatch({
			type: 'switch_view',
			view: { kind: 'session', ref: 'checkout-api/main' },
		});
		await harness.handle({
			type: 'narrate',
			ref: 'checkout-api/main',
			text: 'Done.',
			asked: null,
			isOwed: false,
			spoken: null,
			isSpokenAlready: false,
			isHeld: false,
			hasBackgroundAgents: false,
		});
		expect(harness.seen).toEqual([{ focused: true }]);
	});

	it('the developer spoke to it again while the narrator thought → the old report is not said', async () => {
		const harness = createHarness({
			speak: true,
			needs_user: true,
			priority: 'high',
			text: 'checkout api, main asks: what should it research?',
			topic: null,
		});
		harness.store.dispatch({ type: 'session_started', ref: 'checkout-api/main' });
		const narrated = harness.handle({
			type: 'narrate',
			ref: 'checkout-api/main',
			text: 'Your message cut off. What should I research?',
			asked: 'how hard would it be to',
			isOwed: true,
			spoken: null,
			isSpokenAlready: false,
			isHeld: false,
			hasBackgroundAgents: false,
		});
		harness.store.dispatch({
			type: 'send',
			ref: 'checkout-api/main',
			text: 'how hard would it be to run Voice OS remotely',
			isSpoken: true,
		});
		await narrated;

		expect(harness.spoken).toEqual([]);
		expect(harness.store.state.sessions['checkout-api/main']?.needsUser).toBeNull();
	});

	it('session gone → nothing happens', async () => {
		const harness = createHarness({
			speak: true,
			needs_user: false,
			priority: 'normal',
			text: 'x',
			topic: null,
		});
		await harness.handle({
			type: 'narrate',
			ref: 'gone/main',
			text: 'Done.',
			asked: null,
			isOwed: false,
			spoken: null,
			isSpokenAlready: false,
			isHeld: false,
			hasBackgroundAgents: false,
		});
		expect(harness.spoken).toEqual([]);
	});
});

describe('aside narrator', () => {
	const createAsideHarness = (text: string) => {
		const store = new Store();

		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{
					ref: 'checkout-api/main',
					label: 'checkout-api/main',
					branch: '',
					cwd: '/w',
					dirs: [],
					isPinned: false,
				},
			],
		});

		const inputs: { asked: string | null; focused: boolean; text: string }[] = [];
		const lines: {
			text: string;
			ref: string;
			isNamed: boolean;
			isAsking: boolean;
			priority: string;
		}[] = [];
		const handle = createAsideNarrator({
			store,
			narrate: async (input) => {
				inputs.push(input);

				return { speak: true, needs_user: true, priority: 'low', text, topic: 'Another topic' };
			},
			say: (line) => lines.push(line),
		});

		return { store, inputs, lines, handle };
	};

	it('a tagged answer → its own line said as it is, no summary', async () => {
		const harness = createAsideHarness('unused');

		await harness.handle({
			type: 'narrate_aside',
			ref: 'checkout-api/main',
			question: 'which file?',
			answer: '<spoken>The retry file, `retry.ts`.</spoken>\nIt holds the backoff.',
		});

		expect(harness.inputs).toEqual([]);
		expect(harness.lines).toEqual([
			expect.objectContaining({ text: 'The retry file, .', priority: 'high' }),
		]);
	});

	it('says the answer to the question, named, and never as a question to the developer', async () => {
		const harness = createAsideHarness('The retry file.');

		harness.store.dispatch({
			type: 'switch_view',
			view: { kind: 'session', ref: 'checkout-api/main' },
		});
		await harness.handle({
			type: 'narrate_aside',
			ref: 'checkout-api/main',
			question: 'which file?',
			answer: 'I changed `retry.ts`.',
		});

		expect(harness.inputs).toEqual([
			expect.objectContaining({
				asked: 'which file?',
				focused: true,
				text: 'I changed `retry.ts`.',
			}),
		]);
		expect(harness.lines).toEqual([
			{
				text: 'The retry file.',
				priority: 'high',
				ref: 'checkout-api/main',
				isNamed: true,
				isAsking: false,
			},
		]);
	});

	it('is no turn: no needs-you, no topic change', async () => {
		const harness = createAsideHarness('The retry file.');

		await harness.handle({
			type: 'narrate_aside',
			ref: 'checkout-api/main',
			question: 'which file?',
			answer: 'retry.ts',
		});

		const session = harness.store.state.sessions['checkout-api/main'];

		expect(session?.needsUser).toBeNull();
		expect(session?.topic).toBeNull();
	});

	it('the narrator returned nothing → the answer itself, cleaned for speech', async () => {
		const harness = createAsideHarness('  ');

		await harness.handle({
			type: 'narrate_aside',
			ref: 'checkout-api/main',
			question: 'which file?',
			answer: 'The **retry** file, `src/retry.ts`.',
		});

		const said = harness.lines[0]?.text ?? '';

		expect(said).toStartWith('The retry file');
		expect(said).not.toMatch(/[*`]|src\//);
	});

	it('the session is gone → nothing said', async () => {
		const harness = createAsideHarness('x');

		await harness.handle({ type: 'narrate_aside', ref: 'gone/main', question: 'q', answer: 'a' });

		expect(harness.lines).toEqual([]);
	});
});

describe('settleOwedReport', () => {
	const narration = (patch: Partial<Narration>): Narration => ({
		speak: true,
		needs_user: false,
		priority: 'normal',
		text: '',
		topic: null,
		...patch,
	});

	it('nothing owed → the narration as it was', () => {
		const quiet = narration({ speak: false, priority: 'low' });
		expect(settleOwedReport({ narration: quiet, isOwed: false, sessionText: 'x' })).toBe(quiet);
	});

	it('the narrator stayed silent → spoken, high, its own words kept', () => {
		expect(
			settleOwedReport({
				narration: narration({ speak: false, priority: 'low', text: 'Three timeouts.' }),
				isOwed: true,
				sessionText: 'x',
			}),
		).toMatchObject({ speak: true, priority: 'high', text: 'Three timeouts.' });
	});

	it("nothing written by the narrator → the session's first sentence; nothing at all → it finished", () => {
		const settle = (sessionText: string) =>
			settleOwedReport({ narration: narration({ speak: false }), isOwed: true, sessionText }).text;

		expect(settle("I couldn't read the logs: permission denied. Details follow.")).toBe(
			"I couldn't read the logs: permission denied.",
		);
		expect(settle('')).toBe('It finished.');
	});
});

describe("turn narrator and the session's own line", () => {
	const tagged = (text: string, isAsking = false) => ({ text, isAsking });

	it('a tagged final message → no summary call; said, high and protected, unless it streamed already; the topic kept', async () => {
		const harness = createHarness({
			speak: true,
			needs_user: false,
			priority: 'normal',
			text: 'x',
			topic: 'New topic',
		});
		harness.store.dispatch({ type: 'pin_topic', ref: 'checkout-api/main', topic: 'Timeouts' });

		await harness.handle({
			type: 'narrate',
			ref: 'checkout-api/main',
			text: '<spoken>Tests pass: all 40.</spoken>\nDetails.',
			asked: 'run the tests',
			isOwed: true,
			spoken: { text: 'Tests pass: all 40.', isAsking: false },
			isSpokenAlready: false,
			isHeld: false,
			hasBackgroundAgents: false,
		});
		await harness.handle({
			type: 'narrate',
			ref: 'checkout-api/main',
			text: '<spoken>Done: pushed.</spoken>',
			asked: 'push it',
			isOwed: true,
			spoken: { text: 'Done: pushed.', isAsking: false },
			isSpokenAlready: true,
			isHeld: false,
			hasBackgroundAgents: false,
		});

		expect(harness.seen).toEqual([]);
		expect(harness.spoken).toEqual(['Tests pass: all 40.']);
		expect(harness.said).toEqual([{ priority: 'high', isOwed: true }]);
		expect(harness.store.state.sessions['checkout-api/main']?.topic).toBe('Timeouts');
	});

	it('a tagged question → the session waits on the developer', async () => {
		const harness = createHarness({
			speak: true,
			needs_user: false,
			priority: 'normal',
			text: 'x',
			topic: null,
		});

		await harness.handle({
			type: 'narrate',
			ref: 'checkout-api/main',
			text: '<spoken asks>Push the branch now?</spoken>',
			asked: null,
			isOwed: false,
			spoken: tagged('Push the branch now?', true),
			isSpokenAlready: true,
			isHeld: false,
			hasBackgroundAgents: false,
		});

		expect(harness.store.state.sessions['checkout-api/main']?.needsUser).not.toBeNull();
		expect(harness.spoken).toEqual([]);
	});

	it('no tag and owed → the summary runs on the text without tags, forced to speak', async () => {
		const harness = createHarness({
			speak: false,
			needs_user: false,
			priority: 'low',
			text: '',
			topic: null,
		});

		await harness.handle({
			type: 'narrate',
			ref: 'checkout-api/main',
			text: 'Three timeouts in the last hour.',
			asked: 'check the logs',
			isOwed: true,
			spoken: null,
			isSpokenAlready: false,
			isHeld: false,
			hasBackgroundAgents: false,
		});

		expect(harness.seen).toHaveLength(1);
		expect(harness.spoken).toEqual(['Three timeouts in the last hour.']);
		expect(harness.said).toEqual([{ priority: 'high', isOwed: true }]);
	});
});

describe('the topic of a turn the session spoke for itself', () => {
	const unused: Narration = {
		speak: false,
		needs_user: false,
		priority: 'low',
		text: '',
		topic: null,
	};
	const taggedTurn = {
		type: 'narrate' as const,
		ref: 'checkout-api/main',
		text: '<spoken>Notes are built and committed.</spoken>\nDetails.',
		asked: 'build notes',
		isOwed: true,
		spoken: { text: 'Notes are built and committed.', isAsking: false },
		isSpokenAlready: true,
		isHeld: false,
		hasBackgroundAgents: false,
	};
	const topicOf = (harness: ReturnType<typeof createHarness>) =>
		harness.store.state.sessions['checkout-api/main']?.topic;
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it('named from what was asked and said, and saved on the session', async () => {
		const harness = createHarness(unused, () => 'Voice notes per workspace');
		await harness.handle(taggedTurn);
		await settle();

		expect(harness.topicCalls).toEqual([
			{
				ref: 'checkout-api/main',
				label: 'checkout-api/main',
				asked: 'build notes',
				spoken: 'Notes are built and committed.',
				body: 'Details.',
				topic: null,
			},
		]);
		expect(topicOf(harness)).toBe('Voice notes per workspace');
	});

	it('the writer returns nothing or throws → the topic stays; a pinned topic is kept, and a line that asks nothing needs no call', async () => {
		const empty = createHarness(unused, () => null);
		const throwing = createHarness(unused, () => {
			throw new Error('overloaded');
		});
		const pinned = createHarness(unused, () => 'Something else');

		for (const harness of [empty, throwing]) {
			harness.store.dispatch({ type: 'topic_written', ref: 'checkout-api/main', topic: 'Notes' });
			await harness.handle(taggedTurn);
		}

		pinned.store.dispatch({ type: 'pin_topic', ref: 'checkout-api/main', topic: 'Timeouts' });
		await pinned.handle(taggedTurn);
		await settle();

		expect(empty.topicCalls).toHaveLength(1);
		expect(topicOf(empty)).toBe('Notes');
		expect(throwing.topicCalls).toHaveLength(1);
		expect(topicOf(throwing)).toBe('Notes');
		// A pinned topic needs no call for a line that asks nothing.
		expect(pinned.topicCalls).toEqual([]);
		expect(topicOf(pinned)).toBe('Timeouts');
	});

	it('a turn without its own line → the narrator names it; no topic call', async () => {
		const harness = createHarness({ ...unused, topic: 'Checkout retries' });
		await harness.handle({ ...taggedTurn, text: 'Done.', spoken: null, isSpokenAlready: false });
		await settle();

		expect(harness.topicCalls).toEqual([]);
		expect(topicOf(harness)).toBe('Checkout retries');
	});
});

describe('a session off screen at the end of its turn', () => {
	const REF_ = 'checkout-api/main';
	const LONG_ =
		'The retry backoff is in with jitter, all 96 tests pass, and the branch is pushed for review.';
	const ASK_ =
		'asks: should the backoff cap stay at thirty seconds, or follow the provider limit we found?';

	interface OffScreenHarnessParams {
		narration?: Partial<Narration>;
		about?: string | null;
		// Runs while the narrator waits, as the developer might.
		duringWait?: (store: Store) => void;
	}

	const createOffScreenHarness = ({
		narration = {},
		about = null,
		duringWait,
	}: OffScreenHarnessParams = {}) => {
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{ ref: REF_, label: 'checkout', branch: '', cwd: '/w', dirs: [], isPinned: false },
			],
		});
		const lines: NarratedLineSeen[] = [];
		const handle = createTurnNarrator({
			store,
			narrate: async () => {
				duringWait?.(store);

				return {
					speak: true,
					needs_user: false,
					priority: 'normal',
					text: LONG_,
					topic: null,
					...narration,
				};
			},
			writeTopic: async (input) => {
				duringWait?.(store);

				return { topic: input.topic, about };
			},
			say: (line) => lines.push(line),
			journalDir: mkdtempSync(join(tmpdir(), 'voiceos-off-')),
			readGitHead: async () => null,
		});

		return { store, lines, handle };
	};

	type NarratedLineSeen = {
		text: string;
		ref: string;
		isAsking: boolean;
		isNamed: boolean;
		chime?: 'needs';
		priority: string;
	};

	const tagless = {
		type: 'narrate' as const,
		ref: REF_,
		text: 'Long report.',
		asked: 'add backoff',
		isOwed: false,
		spoken: null,
		isSpokenAlready: false,
		isHeld: false,
		hasBackgroundAgents: false,
	};
	const heldOf = (store: Store) => store.state.sessions[REF_]?.heldLine;

	it('a short line is said where the developer is, named', async () => {
		const harness = createOffScreenHarness({ narration: { text: 'All 96 tests pass.' } });
		await harness.handle(tagless);

		expect(harness.lines.map((line) => [line.text, line.isNamed])).toEqual([
			['All 96 tests pass.', true],
		]);
		expect(heldOf(harness.store)).toBeNull();
	});

	it('a long report → held, and only "checkout is done." said, not asked, today\'s chime', async () => {
		const harness = createOffScreenHarness();
		await harness.handle(tagless);

		expect(harness.lines).toEqual([
			{ text: 'checkout is done.', priority: 'normal', ref: REF_, isNamed: false, isAsking: false },
		]);
		expect(heldOf(harness.store)).toMatchObject({
			kind: 'line',
			text: LONG_,
			isAsking: false,
			missed: 0,
		});
	});

	it('a long question → "checkout needs you: <about>", high, the needs chime; the topic when no about', async () => {
		const withAbout = createOffScreenHarness({
			narration: { needs_user: true, text: ASK_, about: 'the backoff cap' },
		});
		const withTopic = createOffScreenHarness({ narration: { needs_user: true, text: ASK_ } });
		withTopic.store.dispatch({ type: 'pin_topic', ref: REF_, topic: 'Retry backoff' });
		await withAbout.handle(tagless);
		await withTopic.handle(tagless);

		expect(withAbout.lines).toEqual([
			{
				text: 'checkout needs you: the backoff cap.',
				priority: 'high',
				ref: REF_,
				isNamed: false,
				isAsking: false,
				chime: 'needs',
			},
		]);
		expect(withTopic.lines[0]?.text).toBe('checkout needs you: Retry backoff.');
		expect(heldOf(withAbout.store)).toMatchObject({ isAsking: true });
	});

	it('a tagged line held as it streamed → announced once, not held twice; about from the topic writer', async () => {
		const harness = createOffScreenHarness({ about: 'the backoff cap' });
		harness.store.dispatch({ type: 'line_held', ref: REF_, text: ASK_, isAsking: true });
		await harness.handle({ ...tagless, spoken: { text: ASK_, isAsking: true }, isHeld: true });

		expect(harness.lines.map((line) => line.text)).toEqual([
			'checkout needs you: the backoff cap.',
		]);
		expect(heldOf(harness.store)).toMatchObject({ text: ASK_, missed: 0 });
	});

	it('the developer switched there while it thought → the replay was the line: nothing more', async () => {
		const harness = createOffScreenHarness({
			duringWait: (store) =>
				store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: REF_ } }),
		});
		harness.store.dispatch({
			type: 'line_held',
			ref: REF_,
			text: 'Plan approved; building now.',
			isAsking: false,
		});
		await harness.handle(tagless);

		expect(harness.lines).toEqual([]);
	});

	it('a newer line held while it thought (another turn streamed) is no replay → still announced', async () => {
		const harness = createOffScreenHarness({
			duringWait: (store) =>
				store.dispatch({
					type: 'line_held',
					ref: REF_,
					text: 'Started the follow-up: checking the two paid tools against the same list.',
					isAsking: false,
				}),
		});
		harness.store.dispatch({
			type: 'line_held',
			ref: REF_,
			text: 'Plan approved; building the retry backoff and its tests now.',
			isAsking: false,
		});
		await harness.handle(tagless);

		expect(harness.lines.map((line) => line.text)).toEqual(['checkout is done.']);
	});

	it('switched there (nothing held) while it thought → said in full, on screen', async () => {
		const harness = createOffScreenHarness({
			duringWait: (store) =>
				store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: REF_ } }),
		});
		await harness.handle(tagless);

		expect(harness.lines.map((line) => line.text)).toEqual([LONG_]);
		expect(heldOf(harness.store)).toBeNull();
	});

	it('a stale narration is neither said, held nor announced', async () => {
		const harness = createOffScreenHarness({
			duringWait: (store) => {
				store.dispatch({ type: 'session_started', ref: REF_ });
				store.dispatch({ type: 'send', ref: REF_, text: 'now the docs' });
			},
		});
		await harness.handle(tagless);

		expect(harness.lines).toEqual([]);
		expect(heldOf(harness.store)).toBeNull();
	});

	it('a side question asked from elsewhere is answered where the developer is, in full', async () => {
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{ ref: REF_, label: 'checkout', branch: '', cwd: '/w', dirs: [], isPinned: false },
			],
		});
		const lines: string[] = [];
		const narrateAside = createAsideNarrator({
			store,
			narrate: async () => ({
				speak: true,
				needs_user: false,
				priority: 'high',
				text: '',
				topic: null,
			}),
			say: (line) => lines.push(line.text),
		});
		await narrateAside({
			type: 'narrate_aside',
			ref: REF_,
			question: 'which cap?',
			answer: `<spoken>${LONG_}</spoken>`,
		});

		expect(lines).toEqual([LONG_]);
		expect(store.state.sessions[REF_]?.heldLine).toBeNull();
	});
});

describe('off screen, from the stream to what is said', () => {
	const REF_ = 'checkout-api/main';
	const LONG_ =
		'The retry backoff is in with jitter, all 96 tests pass, and the branch is pushed for review.';

	interface TurnParams {
		lines: string[];
		// Views the session before the final line when set.
		isShownFirst?: boolean;
		finalText: string;
		writeTopic?: (input: TopicInput) => Promise<{ topic: string | null; about: string | null }>;
	}

	const runTurn = async ({ lines, isShownFirst = false, finalText, writeTopic }: TurnParams) => {
		const store = new Store();
		const effects: NarrateEffectSeen[] = [];
		store.onEffect((effect) => {
			if (effect.type === 'narrate') {
				effects.push(effect);
			}
		});
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{ ref: REF_, label: 'checkout', branch: '', cwd: '/w', dirs: [], isPinned: false },
			],
		});
		store.dispatch({ type: 'session_started', ref: REF_ });
		store.dispatch({ type: 'send', ref: REF_, text: 'add backoff' });

		if (isShownFirst) {
			store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: REF_ } });
		}

		for (const text of lines) {
			store.dispatch({ type: 'assistant_text', ref: REF_, text: `<spoken>${text}</spoken>` });
		}

		store.dispatch({ type: 'switch_view', view: { kind: 'grid' } });
		store.dispatch({ type: 'turn_ended', ref: REF_, costUsd: 0, text: finalText });

		const said: string[] = [];
		const handle = createTurnNarrator({
			store,
			narrate: async () => ({
				speak: false,
				needs_user: false,
				priority: 'low',
				text: '',
				topic: null,
			}),
			writeTopic: writeTopic ?? (async (input) => ({ topic: input.topic, about: null })),
			say: (line) => said.push(line.text),
			journalDir: mkdtempSync(join(tmpdir(), 'voiceos-flow-')),
			readGitHead: async () => null,
		});

		for (const effect of effects) {
			await handle(effect);
		}

		return { store, said, held: store.state.sessions[REF_]?.heldLine };
	};

	type NarrateEffectSeen = Parameters<ReturnType<typeof createTurnNarrator>>[0];

	it('a short final line → said once, named, and nothing left held', async () => {
		const { said, held } = await runTurn({
			lines: ['All 96 tests pass.'],
			finalText: '<spoken>All 96 tests pass.</spoken>',
		});

		expect(said).toEqual(['All 96 tests pass.']);
		expect(held).toBeNull();
	});

	it('a checkpoint, then a long final → one "is done", the final held with one missed update', async () => {
		const { said, held } = await runTurn({
			lines: ['Plan approved; building now.', LONG_],
			finalText: `<spoken>${LONG_}</spoken>`,
		});

		expect(said).toEqual(['checkout is done.']);
		expect(held).toMatchObject({ kind: 'line', text: LONG_, missed: 1 });
	});

	it('the final line heard on screen, then the developer left → nothing more is said', async () => {
		const { said, held } = await runTurn({
			lines: [LONG_],
			isShownFirst: true,
			finalText: `<spoken>${LONG_}</spoken>`,
		});

		expect(said).toEqual([]);
		expect(held).toBeNull();
	});

	it('a checkpoint held, then the turn ends saying nothing → the replay does not say "still working"', async () => {
		const { store } = await runTurn({
			lines: ['Plan approved; building the notes panel and its tests now.'],
			finalText: '',
		});
		const replayed: string[] = [];
		store.onEffect((effect) => {
			if (effect.type === 'speak') {
				replayed.push(effect.text);
			}
		});
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: REF_ } });

		expect(replayed).toEqual(['Plan approved; building the notes panel and its tests now.']);
	});

	it('a long question: the writer names it; the writer throws → plain "needs you"', async () => {
		const ASK =
			'Should the backoff cap stay at thirty seconds, or follow the provider limit we found yesterday?';
		const named = await runTurn({
			lines: [],
			finalText: `<spoken asks>${ASK}</spoken>`,
			writeTopic: async () => ({ topic: 'Something else', about: 'the backoff cap' }),
		});
		const failed = await runTurn({
			lines: [],
			finalText: `<spoken asks>${ASK}</spoken>`,
			writeTopic: async () => {
				throw new Error('overloaded');
			},
		});

		expect(named.said).toEqual(['checkout needs you: the backoff cap.']);
		expect(failed.said).toEqual(['checkout needs you.']);
	});
});

describe('background sub-agents and follow-up turns off screen (research that outlives its turn)', () => {
	const REF_ = 'checkout-api/main';
	const STARTED =
		'Started the competitor research in the background: worktree tools, agent cockpits and voice control.';
	const REPORT =
		'Found four close competitors; none runs one agent per worktree with its own ports, and none is voice-first.';

	const createFlow = () => {
		const store = new Store();
		const effects: NarrateEffectSeen[] = [];
		const said: string[] = [];
		store.onEffect((effect) => {
			if (effect.type === 'narrate') {
				effects.push(effect);
			}
		});
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{ ref: REF_, label: 'checkout', branch: '', cwd: '/w', dirs: [], isPinned: false },
			],
		});
		store.dispatch({ type: 'session_started', ref: REF_ });
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		const handle = createTurnNarrator({
			store,
			narrate: async () => ({
				speak: false,
				needs_user: false,
				priority: 'low',
				text: '',
				topic: null,
			}),
			writeTopic: async (input) => ({ topic: input.topic, about: null }),
			say: (line) => said.push(line.text),
			journalDir: mkdtempSync(join(tmpdir(), 'voiceos-bg-')),
			readGitHead: async () => null,
		});

		const endTurn = async (line: string, isAsking = false) => {
			const text = `<spoken${isAsking ? ' asks' : ''}>${line}</spoken>`;
			store.dispatch({ type: 'assistant_text', ref: REF_, text });
			store.dispatch({ type: 'turn_ended', ref: REF_, costUsd: 0, text });

			for (const effect of effects.splice(0)) {
				await handle(effect);
			}
		};

		return { store, said, endTurn };
	};

	type NarrateEffectSeen = Parameters<ReturnType<typeof createTurnNarrator>>[0];

	it('the turn ends while a background sub-agent works → held, nothing announced', async () => {
		const { store, said, endTurn } = createFlow();
		store.dispatch({ type: 'send', ref: REF_, text: 'find open-source competitors' });
		store.dispatch({
			type: 'subagent_started',
			ref: REF_,
			taskId: 't1',
			agentType: 'general-purpose',
			description: 'competitor research',
			isBackground: true,
		});
		await endTurn(STARTED);

		expect(said).toEqual([]);
		expect(store.state.sessions[REF_]?.heldLine).toMatchObject({ text: STARTED });
	});

	it('then the report turn → one "is done"; a short afterword turn → neither said nor replacing it', async () => {
		const { store, said, endTurn } = createFlow();
		store.dispatch({ type: 'send', ref: REF_, text: 'find open-source competitors' });
		store.dispatch({
			type: 'subagent_started',
			ref: REF_,
			taskId: 't1',
			agentType: null,
			description: 'competitor research',
			isBackground: true,
		});
		await endTurn(STARTED);
		store.dispatch({ type: 'subagent_ended', ref: REF_, taskId: 't1' });
		await endTurn(REPORT);
		await endTurn('The competitor research is wrapped up, covered in the answer above.');

		expect(said).toEqual(['checkout is done.']);
		expect(store.state.sessions[REF_]?.heldLine).toMatchObject({
			text: REPORT,
			isAnnounced: true,
		});

		const replayed: string[] = [];
		store.onEffect((effect) => {
			if (effect.type === 'speak') {
				replayed.push(effect.text);
			}
		});
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: REF_ } });

		expect(replayed[0]).toStartWith(REPORT.replace(/\.$/, ''));
	});

	it('a second long report before the switch → still one "is done"; a question after it → announced', async () => {
		const { said, endTurn } = createFlow();
		await endTurn(REPORT);
		await endTurn(`${REPORT} Also checked two paid tools; same result there.`);

		expect(said).toEqual(['checkout is done.']);

		await endTurn('Should I write the comparison into a doc for the README?', true);

		expect(said.at(-1)).toStartWith('checkout needs you');
	});
});
