import { describe, expect, it } from 'bun:test';
import { createNullNotes } from '../../test/support/notes.js';
import type Anthropic from '@anthropic-ai/sdk';
import { configureLog } from '../log.js';
import type { Input, ListenMode, PendingAsk } from '../shared/protocol.js';
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
	const heardFroms: number[] = [];
	const kernelCalls: KernelCall[] = [];
	const listenSwitches: ((mode: ListenMode) => string)[] = [];
	const inputs: Input[] = [];
	store.subscribe((stamped) => inputs.push(stamped.input));
	const docOpeners: unknown[] = [];
	const router = new UtteranceRouter({
		store,
		now: () => 5000,
		kernel: async (text, { setListenMode, openUrl, heardFrom, ...options }) => {
			kernelCalls.push({ text, ...options });
			heardFroms.push(heardFrom);
			listenSwitches.push(setListenMode);
			docOpeners.push(openUrl);

			return turn(text);
		},
	});
	const view = (ref: string | null) =>
		store.dispatch({
			type: 'switch_view',
			view: ref ? { kind: 'session', ref } : { kind: 'grid' },
		});

	return { store, router, kernelCalls, listenSwitches, docOpeners, heardFroms, inputs, view };
};

describe('UtteranceRouter', () => {
	it('when the words began reaches the kernel; typed words began when routed', async () => {
		const harness = createHarness(() => ({ reply: '', did: [], calls: [] }));

		await harness.router.handle('run the tests', 'voice', { heardFrom: 1200 });
		await harness.router.handle('run the tests', 'typed');

		expect(harness.heardFroms).toEqual([1200, 5000]);
	});

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

	it('typed "by the way" into a working session\'s box → asked aside', async () => {
		const harness = createHarness();
		harness.view('store-front/main');
		harness.store.dispatch({ type: 'start_session', ref: 'store-front/main' });
		harness.store.dispatch({ type: 'session_started', ref: 'store-front/main' });
		harness.store.dispatch({ type: 'send', ref: 'store-front/main', text: 'refactor it' });

		await harness.router.handle('btw which file was that?', 'typed');

		expect(harness.inputs.at(-1)).toEqual({
			type: 'send',
			ref: 'store-front/main',
			text: 'btw which file was that?',
			aside: true,
		});
	});

	it('the kernel gets the switch for the tab the words came from; none → it says there is no tab', async () => {
		const harness = createHarness();
		const fromTab = () => 'changed' as const;

		await harness.router.handle('stop listening', 'voice', { setListenMode: fromTab });
		await harness.router.handle('stop listening', 'voice');

		expect(harness.listenSwitches[0]).toBe(fromTab);
		expect(harness.listenSwitches[1]?.('push')).toBe('no_tab');
	});

	it('the kernel opens docs in the tab the words came from; none → nothing opens', async () => {
		const harness = createHarness();
		const fromTab = () => true;

		await harness.router.handle('open the doc', 'voice', { openUrl: fromTab });
		await harness.router.handle('open the doc', 'voice');

		expect(harness.docOpeners[0]).toBe(fromTab);
		expect(
			(harness.docOpeners[1] as (url: string, title: string) => boolean)(
				'https://claude.ai/x',
				'x',
			),
		).toBe(false);
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
				notes: createNullNotes(),
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
