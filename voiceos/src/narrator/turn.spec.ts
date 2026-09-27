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

const createHarness = (narration: Narration, topicReply: TopicReply = (input) => input.topic) => {
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

			return topicReply(input);
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
		});
		await harness.handle({
			type: 'narrate',
			ref: 'checkout-api/main',
			text: '<spoken>Done: pushed.</spoken>',
			asked: 'push it',
			isOwed: true,
			spoken: { text: 'Done: pushed.', isAsking: false },
			isSpokenAlready: true,
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
				label: 'checkout-api/main',
				asked: 'build notes',
				spoken: 'Notes are built and committed.',
				body: 'Details.',
				topic: null,
			},
		]);
		expect(topicOf(harness)).toBe('Voice notes per workspace');
	});

	it('the writer keeps it or fails → unchanged; a pinned topic is never asked about', async () => {
		const kept = createHarness(unused);
		const pinned = createHarness(unused, () => 'Something else');
		pinned.store.dispatch({ type: 'pin_topic', ref: 'checkout-api/main', topic: 'Timeouts' });

		await kept.handle(taggedTurn);
		await pinned.handle(taggedTurn);
		await settle();

		expect(topicOf(kept)).toBeNull();
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
