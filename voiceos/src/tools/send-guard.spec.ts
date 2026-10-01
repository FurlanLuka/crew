import { describe, expect, it } from 'bun:test';
import { createToolContext, INSTRUCTION_ACK } from '../../test/support/tool-context.js';
import { judgeAlways, judgeNever, judgeWith } from '../../test/support/english-judge.js';
import { createSession } from '../state/reducer.js';
import type { Judge } from '../judge/judge.js';
import type { State } from '../shared/protocol.js';
import { executeTool, type ToolContext } from './tools.js';

const SCREEN = 'store-front/main';
const CHECKOUT = 'checkout-api/main';

interface SendToParams {
	utterance: string;
	ref?: string;
	judge?: Judge;
	patch?: Partial<State>;
	context?: Partial<ToolContext>;
}

// send_to on store-front/main's screen, with these words said.
const sendTo = async ({
	utterance,
	ref = CHECKOUT,
	judge,
	patch = {},
	context = {},
}: SendToParams) => {
	const { tools, actions } = createToolContext(patch);
	const result = await executeTool(
		'send_to',
		{ ref, kind: 'instruction' },
		{
			...tools,
			...(judge ? { judge } : {}),
			utterance,
			forwardTo: SCREEN,
			screen: SCREEN,
			...context,
		},
	);

	return { result, actions };
};

describe('send_to a session not on screen', () => {
	it('not named → the words go to the session on screen instead, nothing to the one named by the model', async () => {
		const { result, actions } = await sendTo({
			utterance: 'Can you make sure that all the branches will be named the same?',
			judge: judgeNever,
		});

		expect(result.ok).toBe(true);
		expect(actions.filter((action) => action.type === 'send').map((action) => action.ref)).toEqual([
			SCREEN,
		]);
	});

	it('named by its work only ("the checkout retry one") → the screen, like any unnamed send', async () => {
		const { actions } = await sendTo({
			utterance: 'The retry one, run the tests again.',
			judge: judgeNever,
		});

		expect(actions.filter((action) => action.type === 'send').map((action) => action.ref)).toEqual([
			SCREEN,
		]);
	});

	it('named and spoken to → sent', async () => {
		const { result, actions } = await sendTo({ utterance: 'Tell checkout api to run the tests.' });

		expect(result.ok).toBe(true);
		expect(actions).toEqual([
			{
				type: 'send',
				ref: CHECKOUT,
				text: 'Tell checkout api to run the tests.',
				ack: INSTRUCTION_ACK,
			},
		]);
	});

	it('named, only mentioned → "For …?" asked, the words held for the answer', async () => {
		const said = 'Put it on top of the checkout api branch.';
		const { result, actions } = await sendTo({ utterance: said });

		expect(result).toMatchObject({ ok: true, note: 'asked which session' });
		expect(actions).toEqual([{ type: 'ask_which', ref: CHECKOUT, screen: SCREEN, text: said }]);
	});

	it('named, and the judge cannot tell → asked, never sent on a guess', async () => {
		const { actions } = await sendTo({
			utterance: 'Checkout api steht im Weg.',
			judge: judgeAlways('unclear'),
		});

		expect(actions).toEqual([expect.objectContaining({ type: 'ask_which', ref: CHECKOUT })]);
	});

	it('the worktree said as words ("work one") names it', async () => {
		const { actions } = await sendTo({
			ref: 'store-front/wrk1',
			utterance: 'Work one, run the linter.',
			judge: judgeWith({ spoken_to: 'yes' }),
		});

		expect(actions).toEqual([expect.objectContaining({ type: 'send', ref: 'store-front/wrk1' })]);
	});

	it("the developer's own name for it names it", async () => {
		const { actions } = await sendTo({
			utterance: 'Shop Main, rebase it.',
			judge: judgeWith({ spoken_to: 'yes' }),
			patch: { names: { [CHECKOUT]: 'Shop Main' } },
		});

		expect(actions).toEqual([expect.objectContaining({ type: 'send', ref: CHECKOUT })]);
	});

	it('a yes to "Want me to ask it?" → the question it offered goes: the session was named then', async () => {
		const asked = 'How far is it with the backoff?';
		const { actions } = await sendTo({
			utterance: 'Yes.',
			judge: judgeWith({ approves: 'yes' }),
			context: { askedBack: asked },
		});

		expect(actions).toEqual([
			expect.objectContaining({ type: 'send', ref: CHECKOUT, text: asked }),
		]);
	});

	it('crew setup from another screen → the setup session, by its own guard', async () => {
		const { tools } = createToolContext();
		const setup = {
			...createSession({
				ref: 'setup',
				label: 'setup',
				branch: '',
				cwd: '/w',
				dirs: [],
				isPinned: true,
			}),
			status: 'idle' as const,
		};
		const state = tools.getState();
		const { actions } = await sendTo({
			ref: 'setup',
			utterance: 'Add a worktree for the checkout api.',
			judge: judgeWith({ for_setup: 'yes' }),
			patch: { sessions: { ...state.sessions, setup }, order: [...state.order, 'setup'] },
		});

		expect(actions).toEqual([expect.objectContaining({ type: 'send', ref: 'setup' })]);
	});

	it('on Mission Control → no screen to keep the words: sent as the kernel chose', async () => {
		const { actions } = await sendTo({
			utterance: 'Run the tests.',
			judge: judgeNever,
			context: { forwardTo: null, screen: null },
		});

		expect(actions).toEqual([expect.objectContaining({ type: 'send', ref: CHECKOUT })]);
	});
});
