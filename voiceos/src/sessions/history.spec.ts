import { describe, expect, it } from 'bun:test';
import { configureLog } from '../log.js';
import { Store } from '../state/store.js';
import { convertHistoryToStream, restoreHistory, type TranscriptMessage } from './history.js';

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
			{ id: 'h:a2:0', at, kind: 'tool', name: 'Bash', summary: 'run bun test checkout' },
			{ id: 'h:r1:0', at, kind: 'tool_result', ok: true, summary: '96 pass' },
			{ id: 'h:a3:0', at, kind: 'text', text: 'All 96 checkout tests pass.' },
			{ id: 'h:u2', at, kind: 'user', text: 'now push it' },
			{ id: 'h:a4:0', at, kind: 'tool', name: 'Edit', summary: 'edit src/cart.ts' },
			{ id: 'h:r2:0', at, kind: 'tool_result', ok: false, summary: 'File has no changes' },
		]);
	});

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
			store,
			sessions: { 'store-front/main': { sessionId: 'abc' } },
			getCwd: createCwdOf(store),
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
			store,
			sessions: {},
			getCwd: createCwdOf(store),
			loadMessages: async () => [],
		});
		expect(store.state.seq).toBe(seqBefore);
	});

	it('a transcript that cannot be read → skipped, the others still restore', async () => {
		const store = createStore();
		await restoreHistory({
			store,
			sessions: {
				'store-front/main': { sessionId: 'gone' },
				'checkout-api/main': { sessionId: 'ok' },
			},
			getCwd: createCwdOf(store),
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
			store,
			sessions: { 'old/main': { sessionId: 'x' } },
			getCwd: createCwdOf(store),
			loadMessages: async () => {
				reads++;

				return [];
			},
		});
		expect(reads).toBe(0);
	});
});
