import { englishJudge } from '../../test/support/english-judge.js';
import { describe, expect, it } from 'bun:test';
import { createNullNotes } from '../../test/support/notes.js';
import type Anthropic from '@anthropic-ai/sdk';
import { configureLog } from '../log.js';
import type { Input, ListenMode, PendingAsk } from '../shared/protocol.js';
import { Store } from '../state/store.js';
import { Kernel } from './kernel.js';
import { DICTATION_NOTE, UtteranceRouter, type KernelTurn, type RouterOptions } from './router.js';
import type { KernelTurnStart } from '../speech/instant-ack.js';

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
	onKernelTurn?: RouterOptions['onKernelTurn'],
) => {
	const store = new Store();
	store.dispatch({
		type: 'worktrees',
		worktrees: [createWorktree('store-front/main'), createWorktree('checkout-api/main')],
	});
	// Both active, as every session was before the active set; a test deactivates what it needs.
	store.dispatch({ type: 'active_loaded', refs: ['store-front/main', 'checkout-api/main'] });
	const heardFroms: number[] = [];
	const kernelCalls: KernelCall[] = [];
	const listenSwitches: ((mode: ListenMode) => string)[] = [];
	const inputs: Input[] = [];
	store.subscribe((stamped) => inputs.push(stamped.input));
	const docOpeners: unknown[] = [];
	const router = new UtteranceRouter({
		store,
		judge: englishJudge,
		now: () => 5000,
		...(onKernelTurn ? { onKernelTurn } : {}),
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
			judge: englishJudge,
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

	it("typed into an inactive session's box → kept for it, Voice OS asks to activate it; nothing sent, no kernel", async () => {
		const harness = createHarness();
		harness.view('store-front/main');
		harness.store.dispatch({ type: 'deactivate', ref: 'store-front/main' });
		const before = harness.inputs.length;

		await harness.router.handle('run the tests', 'typed');

		expect(harness.kernelCalls).toEqual([]);
		expect(harness.inputs.slice(before)).toEqual([
			{ type: 'send', ref: 'store-front/main', text: 'run the tests' },
			{ type: 'offer_switch', ref: 'store-front/main', kind: 'activate' },
		]);
		expect(harness.store.state.sessions['store-front/main']?.status).toBe('stopped');
		expect(harness.store.state.sessions['store-front/main']?.queue.map((m) => m.text)).toEqual([
			'run the tests',
		]);
		expect(harness.store.state.switchOffer).toMatchObject({
			ref: 'store-front/main',
			kind: 'activate',
		});
	});

	it('typed "by the way" into a working session\'s box → asked aside', async () => {
		const harness = createHarness();
		harness.view('store-front/main');
		harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
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
		harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
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
		const router = new UtteranceRouter({ store, judge: englishJudge, kernel: null, now: () => 1 });

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
		store.dispatch({ type: 'active_loaded', refs: ['store-front/main'] });
		const kernel = new Kernel({
			apiKey: 'k',
			client,
			tools: {
				getState: () => store.state,
				dispatch: (action) => store.dispatch(action),
				readHistory: () => [],
				mute: () => {},
				saveDebugNote: () => {},
				judge: englishJudge,
				notes: createNullNotes(),
			},
		});
		const router = new UtteranceRouter({
			store,
			judge: englishJudge,
			kernel: (text, options) => kernel.handle(text, options),
		});

		await router.handle('Is anything waiting?');
		await router.handle('And now?');

		expect(prompts[1]).toContain('developer: Is anything waiting?\nyou: Nothing is waiting.');
	});

	describe('dictated', () => {
		const DUMP =
			'So checkout-api/main keeps timing out, and I think the retries, um, should back off longer.';

		const handleDictation = (harness: ReturnType<typeof createHarness>) => {
			const kept: { text: string; reason: string }[] = [];

			return harness.router
				.handle(DUMP, 'dictated', {
					heardFrom: 1200,
					keepDictation: (text, reason) => kept.push({ text, reason }),
				})
				.then(() => kept);
		};

		it('a session on screen → sent word for word with the dictation note, never through the kernel, and logged', async () => {
			const harness = createHarness();
			harness.view('store-front/main');

			const kept = await handleDictation(harness);

			expect(harness.kernelCalls).toEqual([]);
			expect(kept).toEqual([]);
			expect(harness.inputs).toContainEqual({
				type: 'send',
				ref: 'store-front/main',
				text: DUMP,
				note: DICTATION_NOTE,
			});
			expect(harness.store.state.voiceLog['store-front/main']?.at(-1)).toMatchObject({
				utterance: DUMP,
				did: ['dictated to store-front/main'],
			});
		});

		it('an inactive session on screen → kept for it, Voice OS asks to activate it; nothing sent, never started', async () => {
			const harness = createHarness();
			harness.view('store-front/main');
			harness.store.dispatch({ type: 'deactivate', ref: 'store-front/main' });
			const before = harness.inputs.length;

			const kept = await handleDictation(harness);

			expect(harness.kernelCalls).toEqual([]);
			expect(kept).toEqual([]);
			expect(harness.inputs.slice(before)).toEqual([
				{
					type: 'send',
					ref: 'store-front/main',
					text: DUMP,
					note: expect.stringContaining('dictated'),
				},
				{ type: 'offer_switch', ref: 'store-front/main', kind: 'activate' },
			]);
			expect(harness.store.state.sessions['store-front/main']?.status).toBe('stopped');
		});

		it('another session named inside the dump → still the session on screen', async () => {
			const harness = createHarness();
			harness.view('store-front/main');

			await handleDictation(harness);

			expect(harness.inputs).toContainEqual(expect.objectContaining({ ref: 'store-front/main' }));
		});

		it('no session on screen → kept in the input, said once, nothing sent', async () => {
			const harness = createHarness();
			harness.view(null);

			const kept = await handleDictation(harness);

			expect(kept).toEqual([{ text: DUMP, reason: 'no session on screen' }]);
			expect(harness.kernelCalls).toEqual([]);
			expect(harness.inputs.some((input) => input.type === 'send')).toBe(false);
			expect(harness.inputs).toContainEqual(
				expect.objectContaining({ type: 'spoken', source: 'alert' }),
			);
		});

		it('the session waits on a permission → kept in the input: a dump must never answer it', async () => {
			const harness = createHarness();
			harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
			harness.store.dispatch({ type: 'session_started', ref: 'store-front/main' });
			harness.store.dispatch({
				type: 'ask_opened',
				ask: {
					id: 'p1',
					ref: 'store-front/main',
					at: 1,
					kind: 'permission',
					toolName: 'Bash',
					summary: 'run git push',
					input: {},
					suggestions: [],
				},
			});
			harness.view('store-front/main');

			const kept = await handleDictation(harness);

			expect(kept).toEqual([{ text: DUMP, reason: 'store-front/main waits on an answer' }]);
			expect(harness.kernelCalls).toEqual([]);
		});
	});

	describe('the instant ack', () => {
		const REQUEST = 'run the tests in the api please';

		const ackHarness = (turn?: (text: string) => KernelTurn) => {
			const turns: KernelTurnStart[] = [];
			const over: string[] = [];
			const harness = createHarness(turn, (started) => {
				turns.push(started);

				return { cancel: () => over.push(started.text) };
			});

			return { ...harness, turns, over };
		};

		it('spoken words for the kernel → its clock starts as the router takes them, and stops with the turn', async () => {
			const harness = ackHarness();

			await harness.router.handle(REQUEST, 'voice', { heardFrom: 1200 });

			expect(harness.turns).toEqual([{ text: REQUEST, startedAt: 5000 }]);
			expect(harness.over).toEqual([REQUEST]);
		});

		it('the kernel fails → the turn still stops', async () => {
			const harness = ackHarness(() => {
				throw new Error('model down');
			});

			await harness.router.handle(REQUEST, 'voice');

			expect(harness.over).toEqual([REQUEST]);
		});

		it('typed or dictated → never: nobody waits in silence for them', async () => {
			const harness = ackHarness();
			harness.view('store-front/main');

			await harness.router.handle(REQUEST, 'typed');
			await harness.router.handle(REQUEST, 'dictated');

			expect(harness.turns).toEqual([]);
		});

		it('the clock starts as the router takes the words, before a slow judge reads them', async () => {
			let clock = 1_000;
			const store = new Store(() => clock);
			store.dispatch({
				type: 'worktrees',
				worktrees: [createWorktree('store-front/main'), createWorktree('checkout-api/main')],
			});
			store.dispatch({ type: 'active_loaded', refs: ['store-front/main', 'checkout-api/main'] });
			store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
			store.dispatch({ type: 'offer_switch', ref: 'checkout-api/main' });
			const turns: KernelTurnStart[] = [];
			const router = new UtteranceRouter({
				store,
				now: () => clock,
				// Not a bare no, read in 400 ms: the words go on to the kernel.
				judge: async () => {
					clock += 400;

					return 'no';
				},
				kernel: async () => ({ reply: '', did: [], calls: [] }),
				onKernelTurn: (turn) => {
					turns.push(turn);

					return { cancel: () => undefined };
				},
			});

			await router.handle('nope, the other one', 'voice', { heardFrom: 1_001 });

			expect(clock).toBe(1_400);
			expect(turns).toEqual([{ text: 'nope, the other one', startedAt: 1_000 }]);
		});

		it('"For checkout?" answered yes by voice → settled by the router, never', async () => {
			const harness = ackHarness();
			harness.view('store-front/main');
			harness.store.dispatch({
				type: 'ask_which',
				ref: 'checkout-api/main',
				screen: 'store-front/main',
				text: 'put it on top of the checkout branch',
			});
			const asked = harness.store.state.targetAsk;

			await harness.router.handle('yes', 'voice', { heardFrom: (asked?.at ?? 0) + 1 });

			expect(asked).not.toBeNull();
			expect(harness.kernelCalls).toEqual([]);
			expect(harness.turns).toEqual([]);
		});

		it('settled by the router (a bare no to "Switch to …?") → never', async () => {
			const harness = ackHarness();
			harness.view('store-front/main');
			harness.store.dispatch({ type: 'offer_switch', ref: 'checkout-api/main' });
			const offer = harness.store.state.switchOffer;

			await harness.router.handle('no', 'voice', { heardFrom: (offer?.at ?? 0) + 1 });

			expect(harness.inputs).toContainEqual(
				expect.objectContaining({ type: 'switch_offer_closed' }),
			);
			expect(harness.kernelCalls).toEqual([]);
			expect(harness.turns).toEqual([]);
		});
	});
});
