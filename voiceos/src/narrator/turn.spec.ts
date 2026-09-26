import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory } from '../memory/journal.js';
import { Store } from '../state/store.js';
import type { Narration } from './prompt.js';
import { createAsideNarrator, createTurnNarrator, settleOwedReport } from './turn.js';

const createHarness = (narration: Narration) => {
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
	const handle = createTurnNarrator({
		store,
		narrate: async (input) => {
			seen.push({ focused: input.focused });

			return narration;
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

	return { store, spoken, asking, said, journalDir, seen, handle };
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
			owed: null,
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
			owed: null,
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
			owed: null,
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
			owed: null,
		});
		expect(harness.seen).toEqual([{ focused: true }]);
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
			owed: null,
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
	const LOGS = { tasks: ['Checking the logs'] };
	const settle = (patch: Partial<Narration>, sessionText = 'Three timeouts in the last hour.') =>
		settleOwedReport({ narration: narration(patch), owed: LOGS, sessionText });

	it('nothing owed → the narration as it was', () => {
		const quiet = narration({ speak: false, priority: 'low' });
		expect(settleOwedReport({ narration: quiet, owed: null, sessionText: 'x' })).toBe(quiet);
	});

	it("the narrator stayed silent → spoken, high, the task and the session's first sentence", () => {
		expect(settle({ speak: false, priority: 'low' })).toMatchObject({
			speak: true,
			priority: 'high',
			text: 'Checking the logs: Three timeouts in the last hour.',
		});
	});

	it('a failure is reported as said, never as done', () => {
		expect(settle({ speak: false }, "I couldn't read the logs: permission denied.").text).toBe(
			"Checking the logs: I couldn't read the logs: permission denied.",
		);
	});

	it('nothing written at all → the task finished', () => {
		expect(settle({ speak: false }, '').text).toBe('Checking the logs finished.');
		expect(
			settleOwedReport({
				narration: narration({ speak: false }),
				owed: { tasks: [] },
				sessionText: '',
			}).text,
		).toBe('It finished.');
	});

	it('a report that does not name the task → the task in front', () => {
		expect(settle({ text: 'Three timeouts in the last hour.' }).text).toBe(
			'Checking the logs: Three timeouts in the last hour.',
		);
		expect(settle({ text: 'The logs show three timeouts.' }).text).toBe(
			'The logs show three timeouts.',
		);
	});

	it('two tasks, the line names one → both in front', () => {
		expect(
			settleOwedReport({
				narration: narration({ text: 'The logs show three timeouts.' }),
				owed: { tasks: ['Checking the logs', 'Running the tests'] },
				sessionText: 'x',
			}).text,
		).toBe('Checking the logs and running the tests: The logs show three timeouts.');
	});

	it("waiting on the developer with nothing written → the task and the session's own question", () => {
		expect(
			settle({ needs_user: true, priority: 'high', text: '' }, 'Rotate the key now?').text,
		).toBe('Checking the logs: Rotate the key now?');
	});

	it.each<[string, boolean, number | undefined, boolean]>([
		['on screen, acked 5 s ago', true, 5_000, false],
		['on screen, acked exactly 10 s ago', true, 10_000, false],
		['on screen, acked 11 s ago', true, 11_000, true],
		['another session on screen, acked 1 s ago', false, 1_000, true],
		['on screen, no ack time', true, undefined, true],
	])('turn narrator: %s → task in front: %p', async (_why, isOnScreen, msAgo, hasPrefix) => {
		const harness = createHarness({
			speak: true,
			needs_user: false,
			priority: 'normal',
			text: 'Three timeouts.',
			topic: null,
		});
		const nowMs = new Date('2026-09-25T02:00:00Z').getTime();

		if (isOnScreen) {
			harness.store.dispatch({
				type: 'switch_view',
				view: { kind: 'session', ref: 'checkout-api/main' },
			});
		}

		await harness.handle({
			type: 'narrate',
			ref: 'checkout-api/main',
			text: 'Three timeouts.',
			asked: 'check the logs',
			owed: {
				tasks: ['Checking the logs'],
				...(msAgo === undefined ? {} : { ackedAt: nowMs - msAgo }),
			},
		});
		expect(harness.spoken).toEqual([
			hasPrefix ? 'Checking the logs: Three timeouts.' : 'Three timeouts.',
		]);
	});

	it('the ack was just heard with the session on screen → no task in front', () => {
		expect(
			settleOwedReport({
				narration: narration({ text: 'Three timeouts in the last hour.' }),
				owed: LOGS,
				sessionText: 'x',
				isAckFresh: true,
			}).text,
		).toBe('Three timeouts in the last hour.');
	});

	it('a question is the report as it is', () => {
		expect(
			settle({ needs_user: true, priority: 'high', text: 'asks: rotate the key now?' }).text,
		).toBe('asks: rotate the key now?');
	});

	it('the narrator call failed (fallback, silent) → still reported through the turn narrator', async () => {
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
			owed: LOGS,
		});
		expect(harness.spoken).toEqual(['Checking the logs: Three timeouts in the last hour.']);
		expect(harness.said).toEqual([{ priority: 'high', isOwed: true }]);
	});
});
