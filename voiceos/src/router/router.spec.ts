import { describe, expect, it } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { configureLog } from '../log.js';
import type { Input, PendingAsk } from '../shared/protocol.js';
import { Store } from '../state/store.js';
import { Kernel } from './kernel.js';
import { UtteranceRouter, type KernelTurn } from './router.js';

configureLog({ quiet: true });

interface KernelCall {
	text: string;
	forwardTo: string | null;
	screen: string | null;
	isSpoken: boolean;
}

interface FakeCreateParams {
	messages: { content: unknown }[];
}

const createWorktree = (ref: string) => ({
	ref,
	label: ref,
	branch: '',
	cwd: '/w',
	dirs: [],
	isPinned: false,
});

const createHarness = (
	turn: (text: string) => KernelTurn = () => ({ reply: '', did: [], calls: [] }),
) => {
	const store = new Store();
	store.dispatch({
		type: 'worktrees',
		worktrees: [createWorktree('store-front/main'), createWorktree('checkout-api/main')],
	});
	const kernelCalls: KernelCall[] = [];
	const inputs: Input[] = [];
	store.subscribe((stamped) => inputs.push(stamped.input));
	const router = new UtteranceRouter({
		store,
		now: () => 5000,
		kernel: async (text, options) => {
			kernelCalls.push({ text, ...options });

			return turn(text);
		},
	});
	const view = (ref: string | null) =>
		store.dispatch({
			type: 'switch_view',
			view: ref ? { kind: 'session', ref } : { kind: 'grid' },
		});

	return { store, router, kernelCalls, inputs, view };
};

describe('UtteranceRouter', () => {
	it("everything spoken goes to the kernel, with the screen it was said on, and lands in that screen's voice log", async () => {
		const harness = createHarness(() => ({ reply: 'Nothing is waiting.', did: [], calls: [] }));
		harness.view('store-front/main');

		await harness.router.handle('Okay.');
		await harness.router.handle("What's waiting on me?");

		expect(harness.kernelCalls).toEqual([
			{ text: 'Okay.', forwardTo: 'store-front/main', screen: 'store-front/main', isSpoken: true },
			{
				text: "What's waiting on me?",
				forwardTo: 'store-front/main',
				screen: 'store-front/main',
				isSpoken: true,
			},
		]);
		expect(
			harness.store.state.voiceLog['store-front/main']?.map((entry) => entry.utterance),
		).toEqual(['Okay.', "What's waiting on me?"]);
	});

	it('on Mission Control → no screen, logged under the grid', async () => {
		const harness = createHarness();

		await harness.router.handle('restart the dev servers');

		expect(harness.kernelCalls[0]).toMatchObject({ forwardTo: null, screen: null });
		expect(harness.store.state.voiceLog.grid).toHaveLength(1);
	});

	it('what the kernel did and said is logged; a turn that only ignored the words is marked so', async () => {
		const harness = createHarness((text) =>
			text === 'hmm'
				? { reply: '', did: [], calls: [{ name: 'ignore_words' }] }
				: { reply: '', did: ['crew_dev restart store-front/main'], calls: [{ name: 'crew_dev' }] },
		);

		await harness.router.handle('restart the servers');
		await harness.router.handle('hmm');

		expect(harness.store.state.voiceLog.grid).toEqual([
			{
				utterance: 'restart the servers',
				did: ['crew_dev restart store-front/main'],
				reply: '',
				at: 5000,
			},
			{ utterance: 'hmm', did: [], reply: '', at: 5000, isIgnored: true },
		]);
	});

	it('a switch_view during the turn still files it under the screen it was said on', async () => {
		const harness = createHarness();
		const router = new UtteranceRouter({
			store: harness.store,
			kernel: async () => {
				harness.view('checkout-api/main');

				return {
					reply: '',
					did: ['switch_view checkout-api/main'],
					calls: [{ name: 'switch_view' }],
				};
			},
		});
		harness.view('store-front/main');

		await router.handle('open checkout');

		expect(harness.store.state.voiceLog['store-front/main']?.[0]?.did).toEqual([
			'switch_view checkout-api/main',
		]);
		expect(harness.store.state.voiceLog['checkout-api/main']).toBeUndefined();
	});

	it('the kernel fails → the entry is kept, marked failed, said aloud; the next utterance is still handled', async () => {
		const harness = createHarness((text) => {
			if (text === 'boom') {
				throw new Error('api down');
			}

			return { reply: '', did: [], calls: [] };
		});

		await harness.router.handle('boom');
		await harness.router.handle('next');

		expect(
			harness.store.state.voiceLog.grid?.map((entry) => [entry.utterance, entry.isFailed ?? false]),
		).toEqual([
			['boom', true],
			['next', false],
		]);
		expect(harness.store.state.spoken.at(-1)).toMatchObject({ source: 'alert' });
	});

	it("typed into a session's own box → straight to that session, not logged, no kernel", async () => {
		const harness = createHarness();
		harness.view('store-front/main');

		await harness.router.handle('run the tests', 'typed');

		expect(harness.kernelCalls).toEqual([]);
		expect(harness.inputs.at(-1)).toEqual({
			type: 'send',
			ref: 'store-front/main',
			text: 'run the tests',
		});
		expect(harness.store.state.voiceLog['store-front/main']).toBeUndefined();
	});

	it('typed while that session waits on a permission → the kernel answers it (typing "yes" must not deny it)', async () => {
		const harness = createHarness();
		const ask: PendingAsk = {
			id: 'p1',
			ref: 'store-front/main',
			at: 1,
			kind: 'permission',
			toolName: 'Bash',
			summary: 'run git push',
			input: {},
			suggestions: [],
		};
		harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
		harness.store.dispatch({ type: 'session_started', ref: 'store-front/main' });
		harness.store.dispatch({ type: 'ask_opened', ask });
		harness.view('store-front/main');

		await harness.router.handle('yes', 'typed');

		expect(harness.kernelCalls).toEqual([
			{ text: 'yes', forwardTo: 'store-front/main', screen: 'store-front/main', isSpoken: false },
		]);
	});

	it("typed into one session's box but addressed to another by name → the kernel routes it", async () => {
		const harness = createHarness();
		harness.view('store-front/main');

		await harness.router.handle('checkout-api/main, run the tests', 'typed');

		expect(harness.kernelCalls).toEqual([
			{
				text: 'checkout-api/main, run the tests',
				forwardTo: 'store-front/main',
				screen: 'store-front/main',
				isSpoken: false,
			},
		]);
	});

	it('typed on Mission Control → the kernel', async () => {
		const harness = createHarness();

		await harness.router.handle('open checkout', 'typed');

		expect(harness.kernelCalls).toEqual([
			{ text: 'open checkout', forwardTo: null, screen: null, isSpoken: false },
		]);
	});

	it('no kernel → says what is missing, and logs it', async () => {
		const store = new Store();
		const router = new UtteranceRouter({ store, kernel: null, now: () => 1 });

		await router.handle('open checkout');

		expect(store.state.spoken.at(-1)?.text).toContain('Anthropic key');
		expect(store.state.voiceLog.grid?.[0]?.reply).toContain('Anthropic key');
	});

	it('blank words → nothing at all', async () => {
		const harness = createHarness();

		await harness.router.handle('   ');

		expect(harness.kernelCalls).toEqual([]);
		expect(harness.store.state.voiceLog).toEqual({});
	});

	it("real loop: one turn's log is the next turn's memory", async () => {
		// The whole loop: what the router logs is what the kernel reads next time.
		const prompts: string[] = [];
		const client = {
			messages: {
				create: async (params: FakeCreateParams) => {
					if (typeof params.messages[0]?.content === 'string') {
						prompts.push(params.messages[0].content);
					}

					return {
						content: [{ type: 'text', text: 'Nothing is waiting.' }],
						stop_reason: 'end_turn',
					};
				},
			},
		} as unknown as Anthropic;
		const store = new Store();
		store.dispatch({ type: 'worktrees', worktrees: [createWorktree('store-front/main')] });
		const kernel = new Kernel({
			apiKey: 'k',
			client,
			tools: {
				getState: () => store.state,
				dispatch: (action) => store.dispatch(action),
				readHistory: () => [],
				mute: () => {},
				saveDebugNote: () => {},
			},
		});
		const router = new UtteranceRouter({
			store,
			kernel: (text, options) => kernel.handle(text, options),
		});

		await router.handle('Is anything waiting?');
		await router.handle('And now?');

		expect(prompts[1]).toContain('developer: Is anything waiting?\nyou: Nothing is waiting.');
	});
});
