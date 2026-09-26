import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import { Store } from '../state/store.js';
import { SessionManager } from './manager.js';
import { loadRegistry, recordSession } from './registry.js';
import { BRIEFING_VERSION } from './voice-context.js';

configureLog({ quiet: true });

interface FakeQueryParams {
	failResume?: boolean;
	holdTurns?: boolean;
}

interface FakeQueryCall {
	prompt: AsyncIterable<{ message: { content: string } }>;
	options: {
		abortController: AbortController;
		cwd: string;
		resume?: string;
		systemPrompt: { append: string };
	};
}

const createFakeQuery = ({ failResume = false, holdTurns = false }: FakeQueryParams = {}) => {
	// Stands in for the Agent SDK; holdTurns: a turn only ends when interrupted, like a cut reply.
	const started: string[] = [];
	const prompts: string[] = [];
	const sent: string[] = [];
	// Counts interrupts across the fake's lifetime.
	let interrupts = 0;

	const runQuery = ((call: FakeQueryCall) => {
		if (failResume && call.options.resume) {
			return {
				[Symbol.asyncIterator]: () => ({
					next: () => Promise.reject(new Error('No conversation found with session ID')),
				}),
				interrupt: async () => undefined,
				setPermissionMode: async () => undefined,
			};
		}

		started.push(call.options.cwd);
		prompts.push(call.options.systemPrompt.append);

		const { signal } = call.options.abortController;
		const queued: unknown[] = [
			{ type: 'system', subtype: 'init', session_id: `s-${started.length}` },
		];

		// Replaced by each wait so a new message or interrupt wakes the stream.
		let wake: () => void = () => {
			// Nothing is waiting yet.
		};

		void (async () => {
			for await (const message of call.prompt) {
				sent.push(message.message.content);

				if (!holdTurns) {
					queued.push({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 });
				}

				wake();
			}
		})();

		const interrupt = async () => {
			interrupts++;
			queued.push({ type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 });
			wake();

			return { still_queued: [] };
		};

		return {
			async *[Symbol.asyncIterator]() {
				while (!signal.aborted) {
					while (queued.length) {
						yield queued.shift();
					}

					await new Promise<void>((resolve) => {
						wake = resolve;
						signal.addEventListener('abort', () => resolve(), { once: true });
					});
				}
			},
			interrupt,
			setPermissionMode: async () => undefined,
		};
	}) as never;

	return { runQuery, started, prompts, sent, interrupts: () => interrupts };
};

const createHarness = () => {
	const store = new Store();

	store.dispatch({
		type: 'worktrees',
		worktrees: [
			{
				ref: 'store-front/main',
				label: 'store-front/main',
				branch: '',
				cwd: '/w/main',
				dirs: [],
				isPinned: false,
			},
		],
	});

	const orientation = Promise.withResolvers<string>();
	const fake = createFakeQuery();
	const manager = new SessionManager({
		store,
		registryFile: join(mkdtempSync(join(tmpdir(), 'voiceos-mgr-')), 'sessions.json'),
		home: '/h',
		fetchOrientation: () => orientation.promise,
		runQuery: fake.runQuery,
	});

	store.onEffect(manager.handle);

	return { store, manager, orientation, started: fake.started, prompts: fake.prompts };
};

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('SessionManager', () => {
	it("every session is told it is driven by Voice OS, after crew's orientation", async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
		harness.orientation.resolve('## crew\nuse crew dev start');
		await waitTick();
		const prompt = harness.prompts[0] ?? '';
		expect(prompt.startsWith('## crew')).toBe(true);
		expect(prompt).toContain('## Voice OS');
		expect(prompt).toContain('AskUserQuestion');
		harness.manager.stopAll();
	});

	it("crew's orientation unavailable → the session still gets the Voice OS context", async () => {
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{
					ref: 'store-front/main',
					label: 'store-front/main',
					branch: '',
					cwd: '/w/main',
					dirs: [],
					isPinned: false,
				},
			],
		});
		const fake = createFakeQuery();
		const manager = new SessionManager({
			store,
			registryFile: join(mkdtempSync(join(tmpdir(), 'voiceos-mgr-')), 'sessions.json'),
			home: '/h',
			fetchOrientation: () => Promise.reject(new Error('crew start failed')),
			runQuery: fake.runQuery,
		});
		store.onEffect(manager.handle);
		store.dispatch({ type: 'start_session', ref: 'store-front/main' });
		await waitTick();
		expect(fake.prompts[0]?.startsWith('## Voice OS')).toBe(true);
		manager.stopAll();
	});

	it('start → one worker once the orientation arrives; session goes idle', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
		harness.orientation.resolve('orientation');
		await waitTick();

		expect(harness.started).toEqual(['/w/main']);
		expect(harness.manager.listRunning()).toEqual(['store-front/main']);
		expect(harness.store.state.sessions['store-front/main']?.status).toBe('idle');
		harness.manager.stopAll();
	});

	it('stop while the orientation loads → no worker spawns, session stays stopped', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
		harness.store.dispatch({ type: 'stop_session', ref: 'store-front/main' });
		harness.orientation.resolve('orientation');
		await waitTick();

		expect(harness.started).toEqual([]);
		expect(harness.manager.listRunning()).toEqual([]);
		expect(harness.store.state.sessions['store-front/main']?.status).toBe('stopped');
	});

	it('start, stop, start quickly → exactly one worker, none orphaned', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
		harness.store.dispatch({ type: 'stop_session', ref: 'store-front/main' });
		harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
		harness.orientation.resolve('orientation');
		await waitTick();

		expect(harness.started).toHaveLength(1);
		expect(harness.manager.listRunning()).toEqual(['store-front/main']);
		harness.store.dispatch({ type: 'stop_session', ref: 'store-front/main' });
		await waitTick();
		expect(harness.manager.listRunning()).toEqual([]);
	});

	it('a second start while one is preparing → ignored', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
		harness.manager.handle({ type: 'worker_start', ref: 'store-front/main' });
		harness.orientation.resolve('orientation');
		await waitTick();

		expect(harness.started).toHaveLength(1);
		harness.manager.stopAll();
	});

	it('stop → the pending permission ask is denied through the reducer, not left hanging', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
		harness.orientation.resolve('orientation');
		await waitTick();
		const answer = harness.manager.permissions.canUseTool('store-front/main')(
			'Bash',
			{ command: 'ls' },
			{},
		);
		harness.store.dispatch({ type: 'stop_session', ref: 'store-front/main' });

		expect(await answer).toEqual({ behavior: 'deny', message: 'The session was stopped.' });
	});

	describe('briefing a resumed session', () => {
		const createResumedHarness = (briefing?: string, { failResume = false } = {}) => {
			const store = new Store();
			store.dispatch({
				type: 'worktrees',
				worktrees: [
					{
						ref: 'store-front/main',
						label: 'store-front/main',
						branch: '',
						cwd: '/w/main',
						dirs: [],
						isPinned: false,
					},
				],
			});
			const registryFile = join(mkdtempSync(join(tmpdir(), 'voiceos-mgr-')), 'sessions.json');
			// Same id the fake reports, as a real resume keeps its id.
			recordSession({ file: registryFile, ref: 'store-front/main', sessionId: 's-1', briefing });
			const fake = createFakeQuery({ failResume });
			const manager = new SessionManager({
				store,
				registryFile,
				home: '/h',
				fetchOrientation: async () => '',
				runQuery: fake.runQuery,
			});
			store.onEffect(manager.handle);

			return { store, manager, fake, registryFile };
		};

		it('created before the current context → the context goes in front of the next message, once; then recorded', async () => {
			const harness = createResumedHarness('older');
			harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
			await waitTick();
			harness.store.dispatch({ type: 'send', ref: 'store-front/main', text: 'run the tests' });
			await waitTick();
			harness.store.dispatch({ type: 'send', ref: 'store-front/main', text: 'and push' });
			await waitTick();
			expect(harness.fake.sent[0]).toContain('## Voice OS');
			expect(harness.fake.sent[0]?.endsWith('run the tests')).toBe(true);
			expect(harness.fake.sent[1]).toBe('and push');
			expect(loadRegistry(harness.registryFile)['store-front/main']?.briefing).toBe(
				BRIEFING_VERSION,
			);
			harness.manager.stopAll();
		});

		it('already has the current context → messages go as said', async () => {
			const harness = createResumedHarness(BRIEFING_VERSION);
			harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
			await waitTick();
			harness.store.dispatch({ type: 'send', ref: 'store-front/main', text: 'run the tests' });
			await waitTick();
			expect(harness.fake.sent).toEqual(['run the tests']);
			harness.manager.stopAll();
		});

		it('the stream shows what the developer said, not the briefing', async () => {
			const harness = createResumedHarness('older');
			harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
			await waitTick();
			harness.store.dispatch({ type: 'send', ref: 'store-front/main', text: 'run the tests' });
			await waitTick();
			expect(harness.store.state.sessions['store-front/main']?.stream.at(-1)).toMatchObject({
				kind: 'user',
				text: 'run the tests',
			});
			harness.manager.stopAll();
		});

		it('started but nothing sent yet → not recorded as briefed', async () => {
			const harness = createResumedHarness('older');
			harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
			await waitTick();
			expect(loadRegistry(harness.registryFile)['store-front/main']?.briefing).toBe('older');
			harness.manager.stopAll();
		});

		it('a Voice OS note → Claude reads briefing, then the note, then the words; the stream shows only the words', async () => {
			const harness = createResumedHarness('older');
			harness.store.dispatch({
				type: 'send',
				ref: 'store-front/main',
				text: 'Check the dev server logs.',
				note: '(Voice OS: api died.)',
			});
			await waitTick();
			await waitTick();
			const sent = harness.fake.sent[0] ?? '';
			expect(sent.indexOf('## Voice OS')).toBeLessThan(sent.indexOf('(Voice OS: api died.)'));
			expect(sent.endsWith('(Voice OS: api died.)\n\nCheck the dev server logs.')).toBe(true);
			const session = harness.store.state.sessions['store-front/main'];
			expect(session?.stream.filter((item) => item.kind === 'user')).toEqual([
				expect.objectContaining({ text: 'Check the dev server logs.' }),
			]);
			harness.manager.stopAll();
		});

		it('resume fails → the fresh session has the context in its prompt, so its first message goes as said', async () => {
			const harness = createResumedHarness('older', { failResume: true });
			harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
			await waitTick();
			harness.store.dispatch({ type: 'send', ref: 'store-front/main', text: 'run the tests' });
			await waitTick();
			expect(harness.fake.prompts[0]).toContain('## Voice OS');
			expect(harness.fake.sent).toEqual(['run the tests']);
			harness.manager.stopAll();
		});
	});

	it('spoken follow-ups while Claude replies → one interrupt, then the rest of the request as one message', async () => {
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{
					ref: 'store-front/main',
					label: 'store-front/main',
					branch: '',
					cwd: '/w/main',
					dirs: [],
					isPinned: false,
				},
			],
		});
		const fake = createFakeQuery({ holdTurns: true });
		const manager = new SessionManager({
			store,
			registryFile: join(mkdtempSync(join(tmpdir(), 'voiceos-mgr-')), 'sessions.json'),
			home: '/h',
			fetchOrientation: async () => '',
			runQuery: fake.runQuery,
		});
		store.onEffect(manager.handle);
		store.dispatch({ type: 'start_session', ref: 'store-front/main' });
		await waitTick();
		store.dispatch({
			type: 'send',
			ref: 'store-front/main',
			text: 'run the tests',
			isSpoken: true,
		});
		await waitTick();
		store.dispatch({
			type: 'send',
			ref: 'store-front/main',
			text: 'only the checkout ones',
			isSpoken: true,
		});
		store.dispatch({
			type: 'send',
			ref: 'store-front/main',
			text: 'and skip the slow ones',
			isSpoken: true,
		});
		await waitTick();
		await waitTick();

		expect(fake.interrupts()).toBe(1);
		expect(fake.sent).toEqual(['run the tests', 'only the checkout ones and skip the slow ones']);
		expect(store.state.sessions['store-front/main']?.status).toBe('running');
		manager.stopAll();
	});
});
