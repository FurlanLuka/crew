import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory } from '../memory/journal.js';
import { Store } from '../state/store.js';
import type { Narration } from './prompt.js';
import { createAsideNarrator, createTurnNarrator } from './turn.js';

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
	const handle = createTurnNarrator({
		store,
		narrate: async (input) => {
			seen.push({ focused: input.focused });

			return narration;
		},
		say: ({ text, isAsking }) => {
			spoken.push(text);
			asking.push(isAsking);
		},
		journalDir,
		readGitHead: async () => 'abc1234',
		now: () => new Date('2026-09-25T02:00:00Z'),
	});

	return { store, spoken, asking, journalDir, seen, handle };
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
		await harness.handle({ type: 'narrate', ref: 'checkout-api/main', text: 'Done.', asked: null });
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
		await harness.handle({ type: 'narrate', ref: 'gone/main', text: 'Done.', asked: null });
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
