import { describe, expect, it } from 'bun:test';
import { configureLog } from '../log.js';
import { Store } from '../state/store.js';
import { convertHistoryToStream, restoreHistory, type TranscriptMessage } from './history.js';
import { createMediaHooks } from './media.js';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

configureLog({ quiet: true });

const T0 = '2026-09-25T10:00:00.000Z';
const at = Date.parse(T0);
const createUserMessage = (
	uuid: string,
	content: unknown,
	extra: Partial<TranscriptMessage> = {},
): TranscriptMessage => ({ type: 'user', uuid, timestamp: T0, message: { content }, ...extra });
const createAssistantMessage = (
	uuid: string,
	content: unknown[],
	extra: Partial<TranscriptMessage> = {},
): TranscriptMessage => ({
	type: 'assistant',
	uuid,
	timestamp: T0,
	message: { content },
	...extra,
});

const TRANSCRIPT: TranscriptMessage[] = [
	createUserMessage('u1', 'run the checkout tests'),
	createAssistantMessage('a1', [{ type: 'thinking', thinking: '' }]),
	createAssistantMessage('a2', [
		{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test checkout' } },
	]),
	createUserMessage('r1', [{ type: 'tool_result', tool_use_id: 't1', content: '96 pass\n0 fail' }]),
	createAssistantMessage('a3', [{ type: 'text', text: 'All 96 checkout tests pass.' }]),
	createUserMessage('h1', '[Request interrupted by user]'),
	createUserMessage('h2', '<command-name>/clear</command-name>'),
	createUserMessage('h3', [
		{ type: 'text', text: '<local-command-stdout>ok</local-command-stdout>' },
	]),
	createUserMessage('h4', '<system-reminder>background task finished</system-reminder>'),
	createUserMessage('m1', 'meta line', { isMeta: true }),
	createAssistantMessage('s1', [{ type: 'text', text: 'subagent chatter' }], { isSidechain: true }),
	createAssistantMessage('s2', [{ type: 'text', text: 'subagent reply' }], {
		parent_tool_use_id: 't9',
	}),
	createUserMessage('u2', [{ type: 'text', text: 'now push it' }]),
	createAssistantMessage('a4', [
		{
			type: 'tool_use',
			id: 't2',
			name: 'Edit',
			input: { file_path: '/w/store-front/src/cart.ts' },
		},
	]),
	createUserMessage('r2', [
		{ type: 'tool_result', tool_use_id: 't2', content: 'File has no changes', is_error: true },
	]),
];

describe('convertHistoryToStream', () => {
	it('transcript → the stream the cockpit showed live, harness lines left out', () => {
		expect(
			convertHistoryToStream({
				messages: TRANSCRIPT,
				ref: 'store-front/main',
				cwd: '/w/store-front',
				now: 0,
			}),
		).toEqual([
			{ id: 'h:u1', at, kind: 'user', text: 'run the checkout tests' },
			{
				id: 'h:a2:0',
				at,
				kind: 'tool',
				name: 'Bash',
				summary: 'run bun test checkout',
				toolUseId: 't1',
			},
			{ id: 'h:r1:0', at, kind: 'tool_result', ok: true, summary: '96 pass' },
			{ id: 'h:a3:0', at, kind: 'text', text: 'All 96 checkout tests pass.' },
			{ id: 'h:u2', at, kind: 'user', text: 'now push it' },
			{
				id: 'h:a4:0',
				at,
				kind: 'tool',
				name: 'Edit',
				summary: 'edit src/cart.ts',
				toolUseId: 't2',
			},
			{ id: 'h:r2:0', at, kind: 'tool_result', ok: false, summary: 'File has no changes' },
		]);
	});

	it('the retry sent after "allow it" → restored as the approval; the developer\'s words stay theirs', () =>
		expect(
			convertHistoryToStream({
				messages: [
					createUserMessage('u1', 'push it'),
					createUserMessage('u2', 'The user allows this once: retry "run git push" now.'),
				],
				ref: 'store-front/main',
				now: 0,
			}),
		).toEqual([
			{ id: 'h:u1', at, kind: 'user', text: 'push it' },
			{
				id: 'h:u2',
				at,
				kind: 'user',
				text: 'The user allows this once: retry "run git push" now.',
				isApproval: true,
			},
		]));

	it('a message with its spoken line → restored without the tag', () =>
		expect(
			convertHistoryToStream({
				messages: [
					createAssistantMessage('a9', [
						{ type: 'text', text: '<spoken>Tests pass.</spoken>\nAll 96.' },
					]),
				],
				ref: 'store-front/main',
				now: 0,
			}),
		).toEqual([{ id: 'h:a9:0', at, kind: 'text', text: 'All 96.' }]));

	it('empty transcript → empty stream', () =>
		expect(convertHistoryToStream({ messages: [], ref: 'r', now: 0 })).toEqual([]));

	it('missing or bad timestamp → the restore time', () => {
		const items = convertHistoryToStream({
			messages: [
				createUserMessage('u', 'hi', { timestamp: undefined }),
				createUserMessage('v', 'yo', { timestamp: 'garbage' }),
			],
			ref: 'r',
			now: 42,
		});
		expect(items.map((item) => item.at)).toEqual([42, 42]);
	});

	it('long transcript → only the newest 400 items', () => {
		const messages = Array.from({ length: 450 }, (_, index) =>
			createUserMessage(`u${index}`, `prompt ${index}`),
		);
		const items = convertHistoryToStream({ messages, ref: 'r', now: 0 });
		expect(items).toHaveLength(400);
		expect(items[0]).toMatchObject({ text: 'prompt 50' });
	});
});

describe('restoreHistory', () => {
	const createStore = () => {
		const store = new Store();

		store.dispatch({
			type: 'worktrees',
			worktrees: ['store-front/main', 'checkout-api/main'].map((ref) => ({
				ref,
				label: ref,
				branch: 'main',
				cwd: `/w/${ref}`,
				dirs: [],
				isPinned: false,
			})),
		});

		return store;
	};

	const createCwdOf = (store: Store) => (ref: string) => store.state.sessions[ref]?.cwd ?? null;

	it('stored session → its stream filled from the transcript read in its cwd', async () => {
		const store = createStore();
		const reads: string[] = [];
		await restoreHistory({
			dispatch: (observation) => store.dispatch(observation),
			sessions: { 'store-front/main': { sessionId: 'abc' } },
			getCwd: createCwdOf(store),
			getImageSource: () => undefined,
			loadMessages: async (sessionId, cwd) => {
				reads.push(`${sessionId}@${cwd}`);

				return [createUserMessage('u1', 'run the tests')];
			},
		});
		expect(reads).toEqual(['abc@/w/store-front/main']);
		expect(store.state.sessions['store-front/main']?.stream.map((item) => item.kind)).toEqual([
			'user',
		]);
		expect(store.state.sessions['checkout-api/main']?.stream).toEqual([]);
	});

	it('no stored session → nothing read, nothing dispatched', async () => {
		const store = createStore();
		const seqBefore = store.state.seq;

		await restoreHistory({
			dispatch: (observation) => store.dispatch(observation),
			sessions: {},
			getCwd: createCwdOf(store),
			getImageSource: () => undefined,
			loadMessages: async () => [],
		});
		expect(store.state.seq).toBe(seqBefore);
	});

	it('a transcript that cannot be read → skipped, the others still restore', async () => {
		const store = createStore();
		await restoreHistory({
			dispatch: (observation) => store.dispatch(observation),
			sessions: {
				'store-front/main': { sessionId: 'gone' },
				'checkout-api/main': { sessionId: 'ok' },
			},
			getCwd: createCwdOf(store),
			getImageSource: () => undefined,
			loadMessages: async (sessionId) => {
				if (sessionId === 'gone') {
					throw new Error('Session gone not found');
				}

				return [createUserMessage('u1', 'hello')];
			},
		});
		expect(store.state.sessions['store-front/main']?.stream).toEqual([]);
		expect(store.state.sessions['checkout-api/main']?.stream).toHaveLength(1);
	});

	it('ref no longer a worktree → skipped', async () => {
		const store = createStore();
		// Counts loads; the stale ref must never reach one.
		let reads = 0;
		await restoreHistory({
			dispatch: (observation) => store.dispatch(observation),
			sessions: { 'old/main': { sessionId: 'x' } },
			getCwd: createCwdOf(store),
			getImageSource: () => undefined,
			loadMessages: async () => {
				reads++;

				return [];
			},
		});
		expect(reads).toBe(0);
	});
});

describe('convertHistoryToStream: what a session showed', () => {
	const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]).toString(
		'base64',
	);
	const screenshot = [
		{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
	];
	const transcript: TranscriptMessage[] = [
		createAssistantMessage('a1', [
			{ type: 'tool_use', id: 't1', name: 'mcp__playwright__browser_take_screenshot', input: {} },
		]),
		createUserMessage('r1', [{ type: 'tool_result', tool_use_id: 't1', content: screenshot }]),
		createAssistantMessage('a2', [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
		createUserMessage('r2', [{ type: 'tool_result', tool_use_id: 't2', content: screenshot }]),
		createAssistantMessage('a3', [
			{ type: 'text', text: 'Plan: [Retry plan](https://claude.ai/artifact/p1)' },
		]),
		createAssistantMessage('a4', [
			{ type: 'text', text: 'Updated [Retry plan](https://claude.ai/artifact/p1)' },
		]),
	];

	const restore = (mediaDir: string | null) =>
		convertHistoryToStream({
			messages: transcript,
			ref: 'store-front/main',
			cwd: '/w/store-front',
			now: 0,
			...(mediaDir
				? {
						media: createMediaHooks({
							session: { cwd: '/w/store-front', dirs: [], isPinned: false },
							mediaDir,
						}),
					}
				: {}),
		}).filter((item) => item.kind === 'image' || item.kind === 'doc');

	it('a screenshot is restored as the same stored image, however often; an image only read is not; a doc linked twice is one card', () => {
		const mediaDir = mkdtempSync(join(tmpdir(), 'history-media-'));

		const first = restore(mediaDir);
		const second = restore(mediaDir);

		expect(first).toEqual([
			{
				id: 'h:r1:1',
				at,
				kind: 'image',
				name: expect.stringMatching(/^[0-9a-f]{32}\.png$/),
				alt: '',
			},
			{ id: 'h:a3:1', at, kind: 'doc', url: 'https://claude.ai/artifact/p1', title: 'Retry plan' },
		]);
		expect(second).toEqual(first);
		expect(readdirSync(mediaDir)).toHaveLength(1);
		rmSync(mediaDir, { recursive: true, force: true });
	});

	it('without a media folder → docs still restored, no images', () => {
		expect(restore(null).map((item) => item.kind)).toEqual(['doc']);
	});
});

describe('restoreHistory: images', () => {
	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3, 3]);

	const restoreImages = async (isPinned: boolean | null) => {
		const worktree = mkdtempSync(join(tmpdir(), 'history-worktree-'));
		const mediaDir = mkdtempSync(join(tmpdir(), 'history-media-'));
		writeFileSync(join(worktree, 'chart.png'), PNG);
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{
					ref: 'store-front/main',
					label: 'store-front/main',
					branch: '',
					cwd: worktree,
					dirs: [],
					isPinned: isPinned ?? false,
				},
			],
		});
		const params = {
			dispatch: (observation: Parameters<typeof store.dispatch>[0]) => {
				store.dispatch(observation);
			},
			sessions: { 'store-front/main': { sessionId: 'abc' } },
			getCwd: (ref: string) => store.state.sessions[ref]?.cwd ?? null,
			getImageSource: (ref: string) => (isPinned === null ? undefined : store.state.sessions[ref]),
			mediaDir,
			loadMessages: async () => [
				createAssistantMessage('a1', [{ type: 'text', text: 'Here: ![chart](./chart.png)' }]),
			],
		};

		await restoreHistory(params);
		const first =
			store.state.sessions['store-front/main']?.stream.filter((item) => item.kind === 'image') ??
			[];
		await restoreHistory(params);
		const second =
			store.state.sessions['store-front/main']?.stream.filter((item) => item.kind === 'image') ??
			[];
		const files = readdirSync(mediaDir);

		rmSync(worktree, { recursive: true, force: true });
		rmSync(mediaDir, { recursive: true, force: true });

		return { first, second, files };
	};

	it('an image named in the text is stored again from the worktree: the same name, one file', async () => {
		const { first, second, files } = await restoreImages(false);

		expect(first).toEqual([
			expect.objectContaining({
				kind: 'image',
				alt: 'chart',
				name: expect.stringMatching(/\.png$/),
			}),
		]);
		expect(second).toEqual(first);
		expect(files).toHaveLength(1);
	});

	it('the setup session, or a session whose folders are unknown → no image', async () => {
		for (const isPinned of [true, null]) {
			const { first, files } = await restoreImages(isPinned);

			expect(first).toEqual([]);
			expect(files).toEqual([]);
		}
	});
});
