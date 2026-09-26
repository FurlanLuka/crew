import { describe, expect, it } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { configureLog } from '../log.js';
import type { Action, VoiceEntry } from '../shared/protocol.js';
import { createFixtureState } from '../../test/support/state.js';
import { Kernel, buildKernelMessage, listWaitingItems, type KernelOptions } from './kernel.js';

configureLog({ quiet: true });

type Block = Anthropic.ContentBlock;
type FixtureState = ReturnType<typeof createFixtureState>;

interface FakeCreateParams {
	messages: { role: string; content: unknown }[];
}

const createFakeClient = (script: Block[][]) => {
	// Counts model calls, and picks the next scripted response.
	let callCount = 0;
	const prompts: string[] = [];
	const client = {
		messages: {
			create: async (params: FakeCreateParams) => {
				const firstContent = params.messages[0]?.content;

				if (typeof firstContent === 'string') {
					prompts.push(firstContent);
				}

				const content = script[callCount++] ?? [{ type: 'text', text: 'done' }];
				const hasToolUse = content.some((block) => block.type === 'tool_use');

				return { content, stop_reason: hasToolUse ? 'tool_use' : 'end_turn' };
			},
		},
	} as unknown as Anthropic;

	return { client, calls: () => callCount, prompts };
};

const createToolUse = (id: string, name: string, input: Record<string, unknown>) =>
	({ type: 'tool_use', id, name, input }) as unknown as Block;

type CreateKernelExtra = Pick<KernelOptions, 'now'> & { log?: Record<string, VoiceEntry[]> };

const createKernel = (script: Block[][], extra: CreateKernelExtra = {}) => {
	const fake = createFakeClient(script);
	const actions: Action[] = [];
	const state = { ...createFixtureState({ view: 'store-front/main' }), voiceLog: extra.log ?? {} };
	const kernel = new Kernel({
		apiKey: 'k',
		client: fake.client,
		tools: {
			getState: () => state,
			dispatch: (action) => actions.push(action),
			readHistory: () => [],
			mute: () => {},
			saveDebugNote: () => {},
		},
		now: extra.now,
	});

	return { kernel, fake, actions };
};

describe('Kernel', () => {
	it('speech forwarded to a session → one model call, no spoken reply', async () => {
		const { kernel, fake, actions } = createKernel([
			[createToolUse('t1', 'send_to', { ref: 'store-front/main', text: 'why is this so slow' })],
		]);

		const result = await kernel.handle('why is this so slow');

		expect(fake.calls()).toBe(1);
		expect(result.reply).toBe('');
		expect(actions).toEqual([
			{ type: 'send', ref: 'store-front/main', text: 'why is this so slow' },
		]);
	});

	it('forward to the session captured at routing → one model call, no spoken reply', async () => {
		const { kernel, fake, actions } = createKernel([
			[createToolUse('t1', 'forward', { text: 'run the tests again' })],
		]);

		const result = await kernel.handle('run the tests again', { forwardTo: 'store-front/main' });

		expect(fake.calls()).toBe(1);
		expect(result.reply).toBe('');
		expect(actions).toEqual([
			{ type: 'send', ref: 'store-front/main', text: 'run the tests again' },
		]);
	});

	it('send_to that fails → the model gets the error and a second turn to recover', async () => {
		const { kernel, fake } = createKernel([
			[createToolUse('t1', 'send_to', { ref: 'nowhere/main', text: 'x' })],
			[{ type: 'text', text: 'Which session?' } as Block],
		]);

		const result = await kernel.handle('send it there');

		expect(fake.calls()).toBe(2);
		expect(result.reply).toBe('Which session?');
	});

	it('navigation that works → one model call, no spoken reply: the screen is the answer', async () => {
		const { kernel, fake, actions } = createKernel([
			[createToolUse('t1', 'switch_view', { ref: 'checkout-api/main' })],
		]);

		const result = await kernel.handle('open checkout');

		expect(fake.calls()).toBe(1);
		expect(result.reply).toBe('');
		expect(actions).toEqual([
			{ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } },
		]);
	});

	it('an answer written beside a navigation call → still spoken, still one model call', async () => {
		const { kernel, fake } = createKernel([
			[
				{ type: 'text', text: 'Checkout needs you.' } as Block,
				createToolUse('t1', 'switch_view', { ref: 'checkout-api/main' }),
			],
		]);

		const result = await kernel.handle('which session needs me');

		expect(fake.calls()).toBe(1);
		expect(result.reply).toBe('Checkout needs you.');
	});

	it('a question that ends with no answer after its tools → asked once more, and that answer is spoken', async () => {
		const { kernel, fake } = createKernel([
			[createToolUse('t1', 'read_state', { ref: null })],
			[],
			[{ type: 'text', text: 'Nothing is waiting.' } as Block],
		]);

		const result = await kernel.handle("what's waiting on me");

		expect(fake.calls()).toBe(3);
		expect(result.reply).toBe('Nothing is waiting.');
	});

	it('an answer written before a checking tool, then an empty last step → that answer is kept, no extra call', async () => {
		const { kernel, fake } = createKernel([
			[
				{ type: 'text', text: 'Nothing is waiting.' } as Block,
				createToolUse('t1', 'read_state', { ref: null }),
			],
			[],
		]);

		const result = await kernel.handle("what's waiting on me");

		expect(fake.calls()).toBe(2);
		expect(result.reply).toBe('Nothing is waiting.');
	});

	it('silent navigation is not asked again', async () => {
		const { kernel, fake } = createKernel([
			[createToolUse('t1', 'switch_view', { ref: 'checkout-api/main' })],
		]);

		await kernel.handle('open checkout');

		expect(fake.calls()).toBe(1);
	});

	it('navigation that fails → the model gets the error and speaks', async () => {
		const { kernel, fake } = createKernel([
			[createToolUse('t1', 'switch_view', { ref: 'nowhere/main' })],
			[{ type: 'text', text: 'No such session.' } as Block],
		]);

		const result = await kernel.handle('open nowhere');

		expect(fake.calls()).toBe(2);
		expect(result.reply).toBe('No such session.');
	});

	it('a question answered from tools → the model still replies after them', async () => {
		const { kernel, fake } = createKernel([
			[createToolUse('t1', 'read_state', { ref: null })],
			[{ type: 'text', text: 'Two are waiting.' } as Block],
		]);

		const result = await kernel.handle('what is waiting');

		expect(fake.calls()).toBe(2);
		expect(result.reply).toBe('Two are waiting.');
	});

	describe('memory per screen (the voice log in State)', () => {
		const createTextBlock = (text: string): Block => ({ type: 'text', text }) as unknown as Block;
		const readEarlierSection = (prompt: string | undefined) =>
			prompt?.split('Earlier on this screen')[1]?.split('Developer said:')[0] ?? '';
		const createEntry = (utterance: string, extra: Partial<VoiceEntry> = {}): VoiceEntry => ({
			utterance,
			did: [],
			reply: '',
			at: 1000,
			...extra,
		});

		it('what was done is shown even when nothing was said; the developer\'s words are "developer:"', async () => {
			const log = {
				'store-front/main': [
					createEntry('Restart the dev servers?', { did: ['crew_dev restart store-front/main'] }),
				],
			};
			const { kernel, fake } = createKernel([[createTextBlock('ok')]], { log, now: () => 2000 });

			await kernel.handle('Okay, also start the session.', { screen: 'store-front/main' });

			const shown = readEarlierSection(fake.prompts[0]);
			expect(shown).toContain('developer: Restart the dev servers?');
			expect(shown).toContain('you did: crew_dev restart store-front/main');
			expect(shown).not.toContain('you: ');
		});

		it('each screen reads only its own entries; Mission Control reads the grid entries', async () => {
			const log = {
				'store-front/main': [createEntry('On store front.')],
				'checkout-api/main': [createEntry('On checkout.')],
				grid: [createEntry('On the grid.')],
			};
			const { kernel, fake } = createKernel([[createTextBlock('a')], [createTextBlock('b')]], {
				log,
				now: () => 2000,
			});

			await kernel.handle('here?', { screen: 'store-front/main' });
			await kernel.handle('here?', { screen: null });

			expect(readEarlierSection(fake.prompts[0])).toContain('On store front.');
			expect(readEarlierSection(fake.prompts[0])).not.toContain('On checkout.');
			expect(readEarlierSection(fake.prompts[1])).toContain('On the grid.');
			expect(readEarlierSection(fake.prompts[1])).not.toContain('On store front.');
		});

		it('entries up to 30 minutes old are read, older ones and ignored ones are not', async () => {
			const now = 1000 + 30 * 60_000;
			const log = {
				grid: [
					createEntry('just in time', { at: 1000 }),
					createEntry('too old', { at: 999 }),
					createEntry('okay', { at: 1000, isIgnored: true }),
				],
			};
			const { kernel, fake } = createKernel([[createTextBlock('a')]], { log, now: () => now });

			await kernel.handle('count', { screen: null });

			expect(readEarlierSection(fake.prompts[0])).toContain('just in time');
			expect(readEarlierSection(fake.prompts[0])).not.toContain('too old');
			expect(readEarlierSection(fake.prompts[0])).not.toContain('developer: okay');
		});

		it('the kernel reports what it did; it writes nothing itself', async () => {
			const { kernel } = createKernel([
				[createToolUse('t1', 'crew_dev', { ref: 'store-front/main', action: 'restart' })],
			]);

			expect(
				await kernel.handle('restart the servers', { screen: 'store-front/main' }),
			).toMatchObject({
				reply: '',
				did: ['crew_dev restart store-front/main'],
			});
		});

		it('the stop guard reads what was said before on this screen', async () => {
			const log = { grid: [createEntry('End the checkout session.', { reply: 'Which one?' })] };
			const { kernel, actions } = createKernel(
				[
					[createToolUse('t2', 'stop_session', { ref: 'checkout-api/main' })],
					[createTextBlock('stopped')],
				],
				{ log, now: () => 2000 },
			);

			// "the main one" alone names nothing; with the checkout mention before it on this screen it does.
			await kernel.handle('stop the main one', { screen: null });

			expect(actions).toEqual([{ type: 'stop_session', ref: 'checkout-api/main' }]);
		});

		it('what Voice OS last asked aloud about a session still waiting is in the message, and marked in the waiting list', async () => {
			const permission = {
				id: 'p1',
				ref: 'store-front/main',
				at: 1,
				kind: 'permission' as const,
				toolName: 'Bash',
				summary: 'run git push',
				input: {},
				suggestions: [],
			};
			const state = {
				...createFixtureState({}),
				asks: [permission],
				spoken: [
					{
						id: 's',
						text: 'store front, main wants to run git push. Allow?',
						source: 'alert' as const,
						at: 4000,
						ref: 'store-front/main',
						isAsking: true as const,
					},
					{ id: 't', text: 'Hands-free stopped.', source: 'alert' as const, at: 5000 },
				],
			};
			const probe = createFakeClient([[createTextBlock('ok')]]);
			const kernel = new Kernel({
				apiKey: 'k',
				client: probe.client,
				tools: {
					getState: () => state,
					dispatch: () => {},
					readHistory: () => [],
					mute: () => {},
					saveDebugNote: () => {},
				},
				now: () => 10_000,
			});

			await kernel.handle('Yes.', { screen: null });

			expect(probe.prompts[0]).toContain(
				'Voice OS last asked aloud: "store front, main wants to run git push. Allow?" (about store-front/main, 6s ago)',
			);
			expect(probe.prompts[0]).toContain('store-front/main (pending, 10s ago, just asked aloud)');
		});

		it('a status line about a waiting session is not what was asked aloud', () => {
			const permission = {
				id: 'p1',
				ref: 'store-front/main',
				at: 1,
				kind: 'permission' as const,
				toolName: 'Bash',
				summary: 'run git push',
				input: {},
				suggestions: [],
			};
			const state = {
				...createFixtureState({ needs: 'checkout-api/main' }, 10_000),
				asks: [permission],
				spoken: [
					{
						id: 's',
						text: 'store front, main wants to run git push. Allow?',
						source: 'alert' as const,
						at: 4000,
						ref: 'store-front/main',
						isAsking: true as const,
					},
					{
						id: 't',
						text: 'restarting dev servers.',
						source: 'narrator' as const,
						at: 5000,
						ref: 'checkout-api/main',
					},
				],
			};

			const message = buildKernelMessage({ state, utterance: 'Yes.', memory: [], now: 10_000 });

			expect(message).toContain(
				'Voice OS last asked aloud: "store front, main wants to run git push. Allow?" (about store-front/main, 6s ago)',
			);
			expect(message).toContain('store-front/main (pending, 10s ago, just asked aloud)');
		});

		it('a line about a session that no longer waits is not "asked aloud"', () => {
			const state = {
				...createFixtureState({}),
				spoken: [
					{
						id: 's',
						text: 'store front, main wants to run git push. Allow?',
						source: 'alert' as const,
						at: 4000,
						ref: 'store-front/main',
						isAsking: true as const,
					},
				],
			};

			expect(buildKernelMessage({ state, utterance: 'Yes.', memory: [], now: 10_000 })).toContain(
				'Voice OS last asked aloud: (nothing)',
			);
		});

		it('what waits on the developer is counted, so a lone yes has one place to go', () => {
			expect(
				buildKernelMessage({
					state: createFixtureState({}),
					utterance: 'Yes.',
					memory: [],
					now: 0,
				}),
			).toContain('Waiting on the developer: nothing\n');

			const now = Date.now();
			const state = createFixtureState(
				{
					ask: 'permission',
					needs: 'checkout-api/main',
					needsSecondsAgo: 5,
					offer: { ref: 'store-front/main', secondsAgo: 60 },
				},
				now,
			);
			expect(buildKernelMessage({ state, utterance: 'Yes.', memory: [], now })).toContain(
				'Waiting on the developer: 3, newest first: checkout-api/main (asked, 5s ago); store-front/wrk1 (pending, 30s ago); store-front/main (fix_offer, 1m ago)\n',
			);

			const staleState = createFixtureState(
				{ offer: { ref: 'store-front/main', secondsAgo: 300 } },
				now,
			);
			expect(
				buildKernelMessage({ state: staleState, utterance: 'Yes.', memory: [], now }),
			).toContain('Waiting on the developer: nothing\n');
		});

		it('the screen and whether it was spoken reach the tools', async () => {
			const { kernel, actions } = createKernel([
				[createToolUse('t1', 'stop_session', { ref: 'store-front/main' })],
				[createTextBlock('Stopped.')],
				[createToolUse('t2', 'forward', { text: 'Run the tests.' })],
			]);

			await kernel.handle('And end this session.', { screen: 'store-front/main' });
			await kernel.handle('run the tests', {
				screen: 'store-front/main',
				forwardTo: 'store-front/main',
				isSpoken: true,
			});

			expect(actions).toEqual([
				{ type: 'stop_session', ref: 'store-front/main' },
				{ type: 'send', ref: 'store-front/main', text: 'Run the tests.', isSpoken: true },
			]);
		});

		it('ignore_words → nothing done, nothing said, no second call', async () => {
			const { kernel, fake, actions } = createKernel([
				[createToolUse('t1', 'ignore_words', { reason: 'unfinished thought' })],
			]);

			const result = await kernel.handle('And can you.', { screen: 'store-front/main' });

			expect(result.reply).toBe('');
			expect(actions).toEqual([]);
			expect(fake.calls()).toBe(1);
		});

		it('an answer written beside ignore_words is still spoken', async () => {
			// Seen live and in the eval: the model answers, then calls ignore_words to mean "nothing else to do".
			const { kernel } = createKernel([
				[
					createTextBlock('The api server died.'),
					createToolUse('t1', 'ignore_words', { reason: 'greeting or acknowledgement' }),
				],
			]);

			const result = await kernel.handle("What's wrong with the dev servers?", {
				screen: 'store-front/main',
			});

			expect(result.reply).toBe('The api server died.');
		});

		it('an utterance that needs nothing → no tools, no reply, and no second call', async () => {
			const { kernel, fake } = createKernel([[]]);

			const result = await kernel.handle('And can you.', { screen: 'store-front/main' });

			expect(result).toEqual({ reply: '', calls: [], did: [] });
			expect(fake.calls()).toBe(1);
		});
	});
});

describe('answers go only to what the developer could have heard', () => {
	const createPermission = (id: string) => ({
		id,
		ref: 'store-front/main',
		at: 1,
		kind: 'permission' as const,
		toolName: 'Bash',
		summary: 'run git push',
		input: {},
		suggestions: [],
	});

	const createRacingKernel = (
		start: FixtureState,
		meanwhile: (state: FixtureState) => FixtureState,
	) => {
		// The state changes while the model thinks: the fake client runs `meanwhile` on its first call.
		let state = start;
		let isFirstCall = true;
		const actions: Action[] = [];
		const fake = createFakeClient([
			[createToolUse('t1', 'answer', { ref: 'store-front/main', decision: 'yes', text: '' })],
			[{ type: 'text', text: 'ok' } as unknown as Block],
		]);
		const create = fake.client.messages.create.bind(fake.client.messages);
		(fake.client.messages as unknown as { create: typeof create }).create = (async (
			params: Parameters<typeof create>[0],
		) => {
			if (isFirstCall) {
				state = meanwhile(state);
			}

			isFirstCall = false;

			return create(params);
		}) as typeof create;
		const kernel = new Kernel({
			apiKey: 'k',
			client: fake.client,
			tools: {
				getState: () => state,
				dispatch: (action) => actions.push(action),
				readHistory: () => [],
				mute: () => {},
				saveDebugNote: () => {},
			},
		});

		return { kernel, actions };
	};

	it('a permission that opens while the model thinks is never answered by words said before it', async () => {
		const { kernel, actions } = createRacingKernel(
			createFixtureState({ view: 'store-front/main' }),
			(state) => ({ ...state, asks: [createPermission('p-new')] }),
		);

		const result = await kernel.handle('Yes.', { screen: 'store-front/main' });

		expect(actions).toEqual([]);
		expect(result.calls[0]).toMatchObject({ name: 'answer', ok: false });
	});

	it('a permission settled while the model thinks → nothing dispatched', async () => {
		const { kernel, actions } = createRacingKernel(
			{ ...createFixtureState({ view: 'store-front/main' }), asks: [createPermission('p1')] },
			(state) => ({ ...state, asks: [] }),
		);

		const result = await kernel.handle('Yes.', { screen: 'store-front/main' });

		expect(actions).toEqual([]);
		expect(result.calls[0]).toMatchObject({ name: 'answer', ok: false });
	});
});

describe('listWaitingItems', () => {
	const now = 10 * 60_000;

	it('nothing waits → nothing', () => {
		expect(listWaitingItems(createFixtureState({}, now), now)).toEqual([]);
	});

	it('an ask and a question a turn ended on → both, newest first', () => {
		const state = createFixtureState(
			{ ask: 'permission', needs: 'checkout-api/main', needsSecondsAgo: 5 },
			now,
		);

		expect(listWaitingItems(state, now)).toEqual([
			{ ref: 'checkout-api/main', what: 'asked', at: now - 5000 },
			{ ref: 'store-front/wrk1', what: 'pending', at: now - 30_000 },
		]);
	});

	it('a fresh fix offer waits; a lapsed one does not', () => {
		const freshState = createFixtureState(
			{ offer: { ref: 'store-front/main', secondsAgo: 10 } },
			now,
		);
		const lapsedState = createFixtureState(
			{ offer: { ref: 'store-front/main', secondsAgo: 300 } },
			now,
		);

		expect(listWaitingItems(freshState, now)).toEqual([
			{ ref: 'store-front/main', what: 'fix_offer', at: now - 10_000 },
		]);
		expect(listWaitingItems(lapsedState, now)).toEqual([]);
	});
});
