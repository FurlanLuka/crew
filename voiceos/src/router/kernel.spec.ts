import { englishJudge, judgeAlways } from '../../test/support/english-judge.js';
import type { Judge } from '../judge/judge.js';
import { describe, expect, it } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { configureLog } from '../log.js';
import type { Action, SpokenLine, State, VoiceEntry } from '../shared/protocol.js';
import { createNullNotes } from '../../test/support/notes.js';
import { createFixtureState, type FixtureContext } from '../../test/support/state.js';
import {
	ASKED_BACK_MS,
	Kernel,
	buildKernelMessage,
	listWaitingItems,
	readAskedBack,
	type KernelOptions,
} from './kernel.js';

// What every instruction carries to the reducer, which says the situation line when there is one.
const INSTRUCTION_ACK = { kind: 'instruction' } as const;

configureLog({ quiet: true });

type Block = Anthropic.ContentBlock;
type FixtureState = ReturnType<typeof createFixtureState>;

interface FakeCreateParams {
	messages: { role: string; content: unknown }[];
	tool_choice?: unknown;
}

const createFakeClient = (script: Block[][]) => {
	// Counts model calls, and picks the next scripted response.
	let callCount = 0;
	const prompts: string[] = [];
	const toolChoices: unknown[] = [];
	const client = {
		messages: {
			create: async (params: FakeCreateParams) => {
				toolChoices.push(params.tool_choice ?? null);
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

	return { client, calls: () => callCount, prompts, toolChoices };
};

const createToolUse = (id: string, name: string, input: Record<string, unknown>) =>
	({ type: 'tool_use', id, name, input }) as unknown as Block;

type CreateKernelExtra = Pick<KernelOptions, 'now'> & {
	log?: Record<string, VoiceEntry[]>;
	context?: FixtureContext;
	// Changes the state as the reducer would, for a tool that reads what an earlier one did.
	onDispatch?: (action: Action, state: State) => void;
	mute?: () => void;
	judge?: Judge;
};

const createKernel = (script: Block[][], extra: CreateKernelExtra = {}) => {
	const fake = createFakeClient(script);
	const actions: Action[] = [];
	const state = {
		...createFixtureState({ view: 'store-front/main', ...extra.context }),
		voiceLog: extra.log ?? {},
	};
	const kernel = new Kernel({
		apiKey: 'k',
		client: fake.client,
		tools: {
			getState: () => state,
			dispatch: (action) => {
				actions.push(action);
				extra.onDispatch?.(action, state);
			},
			readHistory: () => [],
			mute: extra.mute ?? (() => {}),
			saveDebugNote: () => {},
			judge: extra.judge ?? englishJudge,
			notes: createNullNotes(),
		},
		now: extra.now,
	});

	return { kernel, fake, actions, state };
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
			{ type: 'send', ref: 'store-front/main', text: 'why is this so slow', ack: INSTRUCTION_ACK },
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
			{ type: 'send', ref: 'store-front/main', text: 'run the tests again', ack: INSTRUCTION_ACK },
		]);
	});

	it('words written beside a forward → dropped: the session answers, the kernel does not talk over it', async () => {
		const { kernel, fake } = createKernel([
			[
				{ type: 'text', text: 'I understand, you want more detail. Sending it now.' } as Block,
				createToolUse('t1', 'forward', { text: 'Explain it with more detail.' }),
			],
		]);

		const result = await kernel.handle('explain it with more detail', {
			forwardTo: 'store-front/main',
		});

		expect(fake.calls()).toBe(1);
		expect(result.reply).toBe('');
	});

	it('a forward beside a checking tool → what the model says after it is dropped, and it is not asked again', async () => {
		const { kernel, fake } = createKernel([
			[
				createToolUse('t1', 'read_state', { ref: 'store-front/main' }),
				createToolUse('t2', 'forward', { text: 'Where is the code?' }),
			],
			[{ type: 'text', text: 'The branch is main.' } as Block],
		]);

		const result = await kernel.handle('where is the code', { forwardTo: 'store-front/main' });

		expect(fake.calls()).toBe(2);
		expect(result.reply).toBe('');
	});

	it('a forward beside a checking tool, then an empty step → not asked again for words to say', async () => {
		const { kernel, fake } = createKernel([
			[
				createToolUse('t1', 'read_state', { ref: 'store-front/main' }),
				createToolUse('t2', 'forward', { text: 'Where is the code?' }),
			],
			[],
		]);

		const result = await kernel.handle('where is the code', { forwardTo: 'store-front/main' });

		expect(fake.calls()).toBe(2);
		expect(result.reply).toBe('');
	});

	it('on a session screen the first step must call a tool; later steps and Mission Control choose freely', async () => {
		const onScreen = createKernel([
			[createToolUse('t1', 'read_state', { ref: 'store-front/main' })],
			[{ type: 'text', text: 'Nothing is waiting.' } as Block],
		]);

		await onScreen.kernel.handle("what's waiting on me?", { forwardTo: 'store-front/main' });

		expect(onScreen.fake.toolChoices).toEqual([{ type: 'any' }, null]);

		const grid = createKernel([[{ type: 'text', text: 'Nothing is waiting.' } as Block]]);

		await grid.kernel.handle("what's waiting on me?");

		expect(grid.fake.toolChoices).toEqual([null]);
	});

	it('asked again with tools off → no tool choice but none', async () => {
		const { kernel, fake } = createKernel([
			[createToolUse('t1', 'read_state', { ref: null })],
			[],
			[{ type: 'text', text: 'It is idle.' } as Block],
		]);

		const result = await kernel.handle('is it done?', { forwardTo: 'store-front/main' });

		expect(result.reply).toBe('It is idle.');
		expect(fake.toolChoices).toEqual([{ type: 'any' }, null, { type: 'none' }]);
	});

	it('a forward beside an answer that failed → silent: the forward is what happened', async () => {
		const { kernel } = createKernel([
			[
				createToolUse('t1', 'answer', { ref: 'store-front/main', decision: 'yes', text: '' }),
				createToolUse('t2', 'forward', { text: 'Fix everything.' }),
			],
			[{ type: 'text', text: 'The session is no longer waiting — it moved on.' } as Block],
		]);

		const result = await kernel.handle('just fix everything', { forwardTo: 'store-front/main' });

		expect(result.reply).toBe('');
	});

	it('an answer that falls back to sending beside a forward → the words are sent once, as said', async () => {
		const { kernel, actions } = createKernel(
			[
				[
					createToolUse('t1', 'answer', { ref: 'store-front/main', decision: 'yes', text: '' }),
					createToolUse('t2', 'forward', { text: 'Rebuild and restart Voice OS.' }),
				],
				[{ type: 'text', text: '' } as Block],
			],
			{ context: { view: 'store-front/main', needs: 'store-front/main' } },
		);

		await kernel.handle('Okay. Okay, you re- can you, uh, rebuild and restart?', {
			forwardTo: 'store-front/main',
		});

		expect(actions.filter((action) => action.type === 'send')).toEqual([
			expect.objectContaining({
				ref: 'store-front/main',
				text: 'Okay. Okay, you re- can you, uh, rebuild and restart?',
			}),
		]);
	});

	it('the answer fallback to another session whose question was heard still sends there, beside a forward to the screen', async () => {
		const { kernel, actions } = createKernel(
			[
				[
					createToolUse('t1', 'answer', { ref: 'checkout-api/main', decision: 'yes', text: '' }),
					createToolUse('t2', 'forward', { text: 'Run the tests.' }),
				],
				[{ type: 'text', text: '' } as Block],
			],
			{
				context: {
					view: 'store-front/main',
					needs: 'checkout-api/main',
					alert: {
						text: 'checkout api, main asks: deploy the fix to staging?',
						secondsAgo: 5,
						ref: 'checkout-api/main',
					},
				},
			},
		);

		await kernel.handle('yes, and run the tests', { forwardTo: 'store-front/main' });

		expect(actions.filter((action) => action.type === 'send').map((action) => action.ref)).toEqual([
			'store-front/main',
			'checkout-api/main',
		]);
	});

	it('a real pending ask answered beside a forward → the answer runs first, in the model order', async () => {
		const { kernel, actions } = createKernel(
			[
				[
					createToolUse('t1', 'answer', { ref: 'store-front/wrk1', decision: 'yes', text: '' }),
					createToolUse('t2', 'send_to', { ref: 'store-front/wrk1', text: 'Also run the linter.' }),
				],
				[{ type: 'text', text: '' } as Block],
			],
			{ context: { view: 'store-front/wrk1', ask: 'permission' } },
		);

		await kernel.handle('yes, and also run the linter', { forwardTo: 'store-front/wrk1' });

		expect(actions.map((action) => action.type)).toEqual(['answer_permission', 'send']);
		expect(actions[0]).toMatchObject({ decision: 'allow' });
	});

	it('take back beside a send_to that ran first → the words as they were said are taken back', async () => {
		const { kernel, actions, state } = createKernel(
			[
				[
					createToolUse('t1', 'send_to', {
						ref: 'checkout-api/main',
						text: 'Rebuild after commit.',
					}),
					createToolUse('t2', 'queued_message', { ref: 'store-front/main', action: 'drop' }),
				],
				[{ type: 'text', text: '' } as Block],
			],
			{
				onDispatch: (action, current) => {
					if (action.type === 'send') {
						current.lastSpokenSend = { ref: action.ref, id: 'new', text: action.text, at: 2 };
					}
				},
			},
		);
		state.sessions['store-front/main'] = {
			...state.sessions['store-front/main']!,
			status: 'running',
			stream: [
				{
					id: 'aside-1',
					at: 1,
					kind: 'aside',
					question: 'rebuild after commit',
					answer: null,
					status: 'asking',
				},
			],
			queue: [{ id: 'typed-1', text: 'typed earlier', at: 1 }],
		};
		state.lastSpokenSend = { ref: 'store-front/main', id: 'aside-1', text: 'x', at: 1 };

		await kernel.handle('sorry, I meant this for checkout — take it back', {
			forwardTo: 'store-front/main',
		});

		expect(state.lastSpokenSend?.ref).toBe('checkout-api/main');
		expect(actions).toContainEqual({ type: 'take_back', ref: 'store-front/main', id: 'aside-1' });
	});

	it('when the words began reaches the message: a question asked after that is not "asked aloud"', async () => {
		const { kernel, fake } = createKernel([[{ type: 'text', text: '' } as Block]], {
			context: {
				view: 'store-front/main',
				needs: 'checkout-api/main',
				alert: {
					text: 'checkout asks: did you mean another session?',
					secondsAgo: 0.5,
					ref: 'checkout-api/main',
				},
			},
		});

		await kernel.handle('sorry, I meant that for store front', {
			forwardTo: 'store-front/main',
			heardFrom: Date.now() - 3000,
		});

		expect(fake.prompts[0]).toContain('Voice OS last asked aloud: (nothing)');
	});

	it('when the words began reaches the tools: a question asked after that is not answered with them', async () => {
		const { kernel, actions } = createKernel(
			[
				[
					createToolUse('t1', 'answer', {
						ref: 'checkout-api/main',
						decision: 'yes',
						text: 'That was for store front.',
					}),
				],
				[{ type: 'text', text: '' } as Block],
			],
			{ context: { view: 'checkout-api/main', needs: 'checkout-api/main', needsSecondsAgo: 0.5 } },
		);

		await kernel.handle('sorry, that was for store front', {
			forwardTo: 'checkout-api/main',
			heardFrom: Date.now() - 3000,
		});

		expect(actions.filter((action) => action.type === 'send')).toEqual([]);
	});

	it('asking back on a session screen → the words go to the session instead, nothing spoken', async () => {
		const { kernel, actions } = createKernel([
			[createToolUse('t1', 'read_state', { ref: 'store-front/main' })],
			[{ type: 'text', text: "I'm not sure which agent you mean. Can you name it?" } as Block],
		]);

		const result = await kernel.handle('Okay. Can you, um, close the agent?', {
			forwardTo: 'store-front/main',
		});

		expect(result.reply).toBe('');
		expect(result.calls.at(-1)).toMatchObject({ name: 'forward', ok: true });
		expect(actions).toEqual([
			{
				type: 'send',
				ref: 'store-front/main',
				text: 'Okay. Can you, um, close the agent?',
				ack: { kind: 'question' },
			},
		]);
	});

	it('answered from a read of the screen session → the words go to it instead, nothing spoken', async () => {
		const { kernel, actions } = createKernel([
			[createToolUse('t1', 'read_state', { ref: 'store-front/main' })],
			[{ type: 'text', text: "It's still running the tests." } as Block],
		]);

		const result = await kernel.handle('Is it done?', { forwardTo: 'store-front/main' });

		expect(result.reply).toBe('');
		expect(result.calls.map((call) => call.name)).toEqual(['read_state', 'forward']);
		expect(actions).toEqual([
			{ type: 'send', ref: 'store-front/main', text: 'Is it done?', ack: { kind: 'question' } },
		]);
	});

	it('answered from a read of the screen session, words for Voice OS itself → the reply is kept', async () => {
		const { kernel, actions } = createKernel(
			[
				[createToolUse('t1', 'read_state', { ref: 'store-front/main' })],
				[{ type: 'text', text: 'It said the tests pass.' } as Block],
			],
			{ judge: judgeAlways('no') },
		);

		const result = await kernel.handle('Repeat what it said.', { forwardTo: 'store-front/main' });

		expect(result.reply).toBe('It said the tests pass.');
		expect(actions).toEqual([]);
	});

	it('answered from a read of the screen session, the judge unsure → the words go to it: the safe side', async () => {
		const { kernel, actions } = createKernel(
			[
				[createToolUse('t1', 'read_state', { ref: 'store-front/main' })],
				[{ type: 'text', text: "It's still running the tests." } as Block],
			],
			{ judge: judgeAlways('unclear') },
		);

		const result = await kernel.handle('Is it done?', { forwardTo: 'store-front/main' });

		expect(result.reply).toBe('');
		expect(result.calls.map((call) => call.name)).toEqual(['read_state', 'forward']);
		expect(actions).toHaveLength(1);
	});

	it('answered from a read of the screen session, but the words answer Voice OS → the reply is kept', async () => {
		const { kernel, actions, state } = createKernel([
			[createToolUse('t1', 'read_state', { ref: 'store-front/main' })],
			[{ type: 'text', text: 'Yes, the notes.' } as Block],
		]);
		state.spoken.push({
			id: 'asked',
			text: 'Did you mean the debug notes?',
			source: 'kernel',
			at: Date.now() - 60_000,
		});

		const result = await kernel.handle('Yes.', { forwardTo: 'store-front/main' });

		expect(result.reply).toBe('Yes, the notes.');
		expect(result.calls.at(-1)).toMatchObject({ name: 'forward', ok: false });
		expect(actions).toEqual([]);
	});

	it('answered from a read of another session → the reply is kept, nothing asked of the judge', async () => {
		const { kernel, actions } = createKernel(
			[
				[createToolUse('t1', 'read_state', { ref: 'checkout-api/main' })],
				[{ type: 'text', text: 'Checkout is idle.' } as Block],
			],
			{ judge: judgeAlways('yes') },
		);

		const result = await kernel.handle('Is checkout done?', { forwardTo: 'store-front/main' });

		expect(result.reply).toBe('Checkout is idle.');
		expect(actions).toEqual([]);
	});

	it('a lapsed fix offer beside a send_to in the same response → the send_to never runs', async () => {
		const { kernel, fake, actions } = createKernel(
			[
				[
					createToolUse('t1', 'send_to', { ref: 'store-front/main', text: 'Fix the api server.' }),
					createToolUse('t2', 'dev_offer', { accept: true }),
				],
				[{ type: 'text', text: 'The fix offer lapsed.' } as Block],
			],
			{ context: { offer: { ref: 'store-front/main', secondsAgo: 600 } } },
		);

		const result = await kernel.handle('yes, fix it');

		expect(result.reply).toBe('The fix offer lapsed.');
		expect(actions).toEqual([]);
		expect(fake.toolChoices).toEqual([null, { type: 'none' }]);
	});

	it('ignore_words refused on a session screen → the next step must act too, not speak', async () => {
		const { kernel, fake, actions } = createKernel([
			[createToolUse('t1', 'ignore_words', { reason: 'unfinished thought' })],
			[
				createToolUse('t2', 'forward', {
					text: "Maybe we don't always need I'll get back to you.",
				}),
			],
		]);
		const said =
			"Okay, so like, I'll get back to you maybe we don't always need, like, that, but just say okay.";

		await kernel.handle(said, { forwardTo: 'store-front/main' });

		expect(fake.toolChoices).toEqual([{ type: 'any' }, { type: 'any' }]);
		expect(actions).toHaveLength(1);
	});

	it('refused ignore_words, then a lookup → only the next step is forced; the answer is spoken', async () => {
		const { kernel, fake } = createKernel([
			[createToolUse('t1', 'ignore_words', { reason: 'unfinished thought' })],
			[createToolUse('t2', 'read_state', { ref: 'store-front/main' })],
			[{ type: 'text', text: 'It is still running the tests.' } as Block],
		]);

		const result = await kernel.handle(
			'Okay so what is it actually doing right now with all of those tests running?',
			{ forwardTo: 'store-front/main' },
		);

		expect(fake.toolChoices).toEqual([{ type: 'any' }, { type: 'any' }, null]);
		expect(result.reply).toBe('It is still running the tests.');
	});

	it('a long sentence split between a restart and a forward → the forward keeps its own slice, word for word', async () => {
		const { kernel, actions } = createKernel([
			[
				createToolUse('t1', 'crew_dev', { ref: 'store-front/main', action: 'restart' }),
				createToolUse('t2', 'forward', {
					text: 'have it go through the logs for that timeout please.',
				}),
			],
		]);

		await kernel.handle(
			'Okay so restart the dev servers for this one and after that have it go through the logs for that timeout please.',
			{ forwardTo: 'store-front/main' },
		);

		expect(actions).toContainEqual({
			type: 'send',
			ref: 'store-front/main',
			text: 'have it go through the logs for that timeout please.',
			ack: INSTRUCTION_ACK,
		});
	});

	it('a slice beside a restart that was reworded → the words as said, never the rewrite', async () => {
		const said =
			'Restart the dev servers and after that have it go through the logs for that timeout.';
		const { kernel, actions } = createKernel([
			[
				createToolUse('t1', 'crew_dev', { ref: 'store-front/main', action: 'restart' }),
				createToolUse('t2', 'forward', { text: 'Check the logs for the timeout.' }),
			],
		]);

		await kernel.handle(said, { forwardTo: 'store-front/main' });

		expect(actions).toContainEqual({
			type: 'send',
			ref: 'store-front/main',
			text: said,
			ack: INSTRUCTION_ACK,
		});
	});

	it('a lapsed fix offer → answered with tools off, nothing else sent', async () => {
		const { kernel, fake, actions } = createKernel(
			[
				[createToolUse('t1', 'dev_offer', { accept: true })],
				[{ type: 'text', text: 'The fix offer lapsed.' } as Block],
			],
			{ context: { offer: { ref: 'store-front/main', secondsAgo: 600 } } },
		);

		const result = await kernel.handle('yes, fix it');

		expect(result.reply).toBe('The fix offer lapsed.');
		expect(fake.toolChoices.at(-1)).toEqual({ type: 'none' });
		expect(actions).toEqual([]);
	});

	it('a forward beside a call that failed → the words explaining the failure are spoken', async () => {
		const { kernel } = createKernel([
			[
				createToolUse('t1', 'crew_dev', { ref: 'nowhere/main', action: 'restart' }),
				createToolUse('t2', 'forward', { text: 'Check the logs.' }),
			],
			[{ type: 'text', text: 'Could not restart: no such worktree.' } as Block],
		]);

		const result = await kernel.handle('restart the servers and have it check the logs', {
			forwardTo: 'store-front/main',
		});

		expect(result.reply).toBe('Could not restart: no such worktree.');
	});

	it('a forward that fails → its words are kept, the developer hears why', async () => {
		const { kernel } = createKernel([
			[createToolUse('t1', 'forward', { text: 'run it' })],
			[{ type: 'text', text: 'No session is open to send that to.' } as Block],
		]);

		const result = await kernel.handle('run it');

		expect(result.reply).toBe('No session is open to send that to.');
	});

	it('words beside a send_to → still spoken: a question asked with it keeps its answer', async () => {
		const { kernel } = createKernel([
			[
				{ type: 'text', text: 'Two sessions are running.' } as Block,
				createToolUse('t1', 'send_to', { ref: 'store-front/main', text: 'Run the tests.' }),
			],
		]);

		const result = await kernel.handle("what's running, and tell store front to run the tests");

		expect(result.reply).toBe('Two sessions are running.');
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
			{ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' }, announce: true },
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

	it('an activate that found more in the words → the model is asked again for the rest', async () => {
		const { kernel, fake } = createKernel([
			[createToolUse('t1', 'activate', { name: 'checkout api main' })],
			[createToolUse('t2', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })],
		]);

		await kernel.handle('Start checkout api main and run the tests.');

		expect(fake.calls()).toBe(2);
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
					[createToolUse('t2', 'deactivate', { ref: 'checkout-api/main' })],
					[createTextBlock('deactivated')],
				],
				{ log, now: () => 2000 },
			);

			// "the main one" alone names nothing; with the checkout mention before it on this screen it does.
			await kernel.handle('stop the main one', { screen: null });

			expect(actions).toEqual([{ type: 'deactivate', ref: 'checkout-api/main' }]);
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
					judge: englishJudge,
					notes: createNullNotes(),
				},
				now: () => 10_000,
			});

			await kernel.handle('Yes.', { screen: null });

			expect(probe.prompts[0]).toContain(
				'Voice OS last asked aloud: "store front, main wants to run git push. Allow?" (about store-front/main, 6s ago)',
			);
			expect(probe.prompts[0]).toContain('store-front/main (pending, 10s ago, just asked aloud)');
		});

		it('a question only announced is marked so in what waits', () => {
			const message = buildKernelMessage({
				state: createFixtureState(
					{
						view: 'store-front/main',
						announced: {
							ref: 'checkout-api/main',
							question: 'asks: cap the backoff at thirty seconds or follow the provider limit?',
							about: 'the backoff cap',
							secondsAgo: 5,
						},
					},
					10_000,
				),
				utterance: 'yes',
				memory: [],
				now: 10_000,
			});

			expect(message).toContain('checkout-api/main (asked, 5s ago, announced only — not heard)');
			expect(message).toContain('Voice OS last asked aloud: (nothing)');
		});

		it('what the developer heard before speaking: lines from other sessions, not ones started after', () => {
			const state = createFixtureState(
				{
					view: 'store-front/main',
					heard: [
						{
							text: "It's doable without a rewrite.",
							ref: 'checkout-api/main',
							secondsAgo: 20,
							endedSecondsAgo: 8,
						},
						{ text: 'Plan approved.', ref: 'store-front/main', secondsAgo: 5, endedSecondsAgo: 2 },
						{ text: 'did you mean another session?', ref: 'checkout-api/main', secondsAgo: 0.5 },
					],
				},
				10_000,
			);
			const message = buildKernelMessage({
				state,
				utterance: 'what does that mean?',
				memory: [],
				now: 10_000,
				heardFrom: 9_000,
			});

			expect(message).toContain(
				'Heard just before the developer spoke (oldest first): checkout-api/main: "It\'s doable without a rewrite." (ended 7s before they spoke); store-front/main: "Plan approved." (ended 1s before they spoke)',
			);
			expect(message).not.toContain('did you mean another session?');
			expect(
				buildKernelMessage({
					state: createFixtureState({ view: 'store-front/main' }, 10_000),
					utterance: 'run the tests',
					memory: [],
					now: 10_000,
				}),
			).not.toContain('Heard just before the developer spoke');
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
				[createToolUse('t1', 'deactivate', { ref: 'store-front/main' })],
				[createTextBlock('Deactivated.')],
				[createToolUse('t2', 'forward', { text: 'Run the tests.' })],
			]);

			await kernel.handle('And end this session.', { screen: 'store-front/main' });
			await kernel.handle('run the tests', {
				screen: 'store-front/main',
				forwardTo: 'store-front/main',
				isSpoken: true,
			});

			expect(actions).toEqual([
				{ type: 'deactivate', ref: 'store-front/main' },
				{
					type: 'send',
					ref: 'store-front/main',
					text: 'Run the tests.',
					ack: INSTRUCTION_ACK,
					isSpoken: true,
					saidOn: 'store-front/main',
				},
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

		it('a saved debug note → "Debug note saved." whatever the model wrote', async () => {
			const { kernel } = createKernel([
				[createToolUse('t1', 'debug_note', { text: 'it sent it to the wrong session' })],
				[createTextBlock('Noted.')],
			]);

			const result = await kernel.handle('Add a debug note that it sent it to the wrong session.', {
				screen: 'store-front/main',
			});

			expect(result.reply).toBe('Debug note saved.');
		});

		it('a debug note beside a forward → still "Debug note saved."', async () => {
			const { kernel } = createKernel([
				[
					createToolUse('t1', 'debug_note', { text: 'it read every option aloud' }),
					createToolUse('t2', 'forward', { text: 'Run the tests.', kind: 'instruction' }),
				],
				[createTextBlock('Sent.')],
			]);

			const result = await kernel.handle('Debug note: it read every option aloud. Run the tests.', {
				forwardTo: 'store-front/main',
				screen: 'store-front/main',
			});

			expect(result.reply).toBe('Debug note saved.');
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
				judge: englishJudge,
				notes: createNullNotes(),
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

	it('"Activate it?" and "Deactivate anyway?" wait under their own kind', () => {
		const state = createFixtureState({}, now);
		const offered = (kind: 'activate' | 'deactivate'): State => ({
			...state,
			switchOffer: { ref: 'checkout-api/main', at: now - 2000, kind },
		});

		expect(listWaitingItems(offered('activate'), now)).toEqual([
			{ ref: 'checkout-api/main', what: 'activate_offer', at: now - 2000 },
		]);
		expect(listWaitingItems(offered('deactivate'), now)).toEqual([
			{ ref: 'checkout-api/main', what: 'deactivate_offer', at: now - 2000 },
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

describe('kernel context: Active', () => {
	const now = 10_000;
	const readMessage = (state: State, utterance = 'what is going on?') =>
		buildKernelMessage({ state, utterance, memory: [], now });
	const readSessionsLine = (message: string) =>
		message.split('\n').find((line) => line.startsWith('Sessions: ')) ?? '';

	it("only the active sessions are listed, this Mac's setup always among them", () => {
		const state = createFixtureState({ inactive: ['store-front/wrk1', 'checkout-api/main'] }, now);
		const sessions = JSON.parse(readSessionsLine(readMessage(state)).slice('Sessions: '.length));

		expect(sessions.map((session: { ref: string }) => session.ref)).toEqual([
			'setup',
			'store-front/main',
		]);
	});

	it("an inactive session named → not listed, a developer's name for it not either", () => {
		const state: State = {
			...createFixtureState({ inactive: ['store-front/wrk1'] }, now),
			names: { 'store-front/wrk1': 'ranking' },
		};

		expect(readMessage(state)).not.toContain('Named sessions:');
	});

	it('a machine said in the words → its inactive setup on the line; active, or no machine said → not', () => {
		const machine = {
			id: 'personal',
			name: 'Personal',
			refs: ['personal:setup', 'personal:billing/main'],
		};
		const inactive = createFixtureState(
			{ machine, inactive: ['personal:setup', 'personal:billing/main'] },
			now,
		);
		const active = createFixtureState({ machine, inactive: ['personal:billing/main'] }, now);
		const lineOf = (message: string) =>
			message.split('\n').find((line) => line.startsWith('Not active, named')) ?? '';

		expect(lineOf(readMessage(inactive, 'Add a worktree for billing on Personal.'))).toContain(
			'personal:setup',
		);
		expect(lineOf(readMessage(active, 'Add a worktree for billing on Personal.'))).not.toContain(
			'personal:setup',
		);
		expect(lineOf(readMessage(inactive, 'Add a worktree for billing.'))).not.toContain(
			'personal:setup',
		);
	});

	it('the words name an inactive session → one line naming it; nothing named → no line', () => {
		const state: State = {
			...createFixtureState({ inactive: ['checkout-api/main'] }, now),
			names: { 'checkout-api/main': 'retries' },
		};

		expect(readMessage(state, 'tell checkout api main to run the tests')).toContain(
			'Not active, named in these words: retries (checkout-api/main). Not in Sessions: "start", "activate" or "enable" it is activate; any other words for it, call the tool you would anyway (send_to, switch_view…) and Voice OS asks to activate it — say nothing yourself.\n',
		);
		expect(readMessage(state, 'run the tests')).not.toContain('Not active, named');
		expect(
			readMessage(createFixtureState({}, now), 'tell checkout api main to run the tests'),
		).not.toContain('Not active, named');
	});

	it('an inactive session on screen → said not active on the Screen line', () => {
		const state = createFixtureState(
			{ view: 'checkout-api/main', inactive: ['checkout-api/main'] },
			now,
		);

		expect(readMessage(state)).toContain(
			'Screen: looking at checkout-api/main (not active: its Claude is not running and words for it are met with "Activate it?"). What the developer says is for checkout-api/main',
		);
		expect(readMessage(createFixtureState({ view: 'checkout-api/main' }, now))).not.toContain(
			'(not active',
		);
	});

	it("an inactive session's question → not waiting on the developer", () => {
		const state = createFixtureState(
			{ needs: 'checkout-api/main', inactive: ['checkout-api/main'] },
			now,
		);

		expect(readMessage(state)).toContain('Waiting on the developer: nothing\n');
	});

	it('the Active view → a screen line for it', () => {
		const state: State = { ...createFixtureState({}, now), view: { kind: 'active' } };

		expect(readMessage(state)).toContain(
			"Screen: looking at Active: the developer's active sessions, from every machine (Mission Control › Active).",
		);
	});

	it('a session opened from Active → still that session, said opened from Active', () => {
		const state: State = {
			...createFixtureState({}, now),
			view: { kind: 'session', ref: 'store-front/main', from: 'active' },
		};

		expect(readMessage(state)).toContain('Screen: looking at store-front/main, opened from Active');
	});
});

describe('kernel context: session names', () => {
	const now = 10_000;
	const readMessage = (state: State) =>
		buildKernelMessage({ state, utterance: 'go to voice os dev', memory: [], now });

	it('nothing named → no Named line', () => {
		expect(readMessage(createFixtureState({}, now))).not.toContain('Named sessions:');
	});

	it('a named session → listed as "<name> (<ref>)", on the screen line too', () => {
		const state: State = {
			...createFixtureState({ view: 'store-front/main' }, now),
			names: { 'store-front/main': 'voice os dev' },
		};
		const message = readMessage(state);

		expect(message).toContain('Named sessions: voice os dev (store-front/main).');
		expect(message).toContain('Screen: looking at voice os dev (store-front/main). ');
	});
});

describe('a long request forwarded beside a mute (note 83)', () => {
	const SAID =
		"Okay, can you can you paste this to Voi. To crew main, like the debug notes, and just the notes? Uh, and also so when I select remote, which doesn't have anything, I don't want it to connect, like, uh, I don't want it to tell me that nothing is waiting for me. Just be silent, okay? Only say things if there's actually anything to do. But yeah, ask crew main to check debug notes and notes, um, and give me a list, and I'll decide on what to do, okay?";
	const REWRITE = "Check the debug notes and notes, and give me a list. I'll decide what to do.";

	it('forward + mute → the forward is the only send: the words go as said, and nothing is muted', async () => {
		let muted = 0;
		const { kernel, actions } = createKernel(
			[[createToolUse('t1', 'forward', { text: REWRITE }), createToolUse('t2', 'mute', {})]],
			{ mute: () => muted++ },
		);

		await kernel.handle(SAID, { forwardTo: 'store-front/main' });

		expect(actions).toEqual([
			{ type: 'send', ref: 'store-front/main', text: SAID, ack: INSTRUCTION_ACK },
		]);
		expect(muted).toBe(0);
	});

	it('forward + interrupt → interrupt carries no words either: the send carries the words as said', async () => {
		const { kernel, actions } = createKernel([
			[
				createToolUse('t1', 'forward', { text: REWRITE }),
				createToolUse('t2', 'interrupt', { ref: 'store-front/main' }),
			],
		]);

		await kernel.handle(SAID, { forwardTo: 'store-front/main' });

		expect(actions.filter((action) => action.type === 'send')).toEqual([
			{ type: 'send', ref: 'store-front/main', text: SAID, ack: INSTRUCTION_ACK },
		]);
	});

	it('the same words naming another session → split: a part copied word for word goes, a rewrite never', async () => {
		const said = SAID.replace('To crew main', 'To checkout api');
		const part = 'ask crew main to check debug notes and notes, um, and give me a list';

		const send = async (text: string) => {
			const { kernel, actions } = createKernel([
				[createToolUse('t1', 'forward', { text }), createToolUse('t2', 'mute', {})],
			]);

			await kernel.handle(said, { forwardTo: 'store-front/main' });

			return actions;
		};

		expect(await send(part)).toEqual([
			{ type: 'send', ref: 'store-front/main', text: part, ack: INSTRUCTION_ACK },
		]);
		expect(await send(REWRITE)).toEqual([
			{ type: 'send', ref: 'store-front/main', text: said, ack: INSTRUCTION_ACK },
		]);
	});
});

describe('readAskedBack', () => {
	const ASKED = 'How long do you think checkout is going to take?';
	const entry = (patch: Partial<VoiceEntry> = {}): VoiceEntry => ({
		utterance: ASKED,
		did: [],
		reply: "I don't know — want me to ask it?",
		at: 1_000,
		...patch,
	});
	const read = (memory: VoiceEntry[], now = 30_000, spoken: SpokenLine[] = []) =>
		readAskedBack({ memory, spoken, now });

	it('its last turn only asked back, a moment ago → the words it offered to ask', () => {
		expect(read([entry()])).toEqual({ askedBack: ASKED });
	});

	it('words said to Voice OS, or a list read back → never words it offered to pass on', () => {
		expect(read([entry({ utterance: "Voice OS, what's on Personal?" })])).toEqual({});
		expect(read([entry({ did: ['list_sessions'] })])).toEqual({});
	});

	it('something done, a reply that asks nothing, a failed turn → nothing', () => {
		expect(read([entry({ did: ['send_to checkout-api/main "x"'] })])).toEqual({});
		expect(read([entry({ reply: 'It is still running.' })])).toEqual({});
		expect(read([entry({ isFailed: true })])).toEqual({});
	});

	it('past two minutes, or a session spoke since → nothing: a yes now answers that', () => {
		expect(read([entry()], 1_000 + ASKED_BACK_MS + 1)).toEqual({});
		expect(
			read([entry()], 30_000, [
				{ id: 'l1', text: 'Should I push?', source: 'narrator', at: 5_000, ref: 'crew/main' },
			]),
		).toEqual({});
	});
});
