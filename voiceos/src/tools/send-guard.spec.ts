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
	utterance: string | undefined;
	ref?: string;
	// The part the kernel gave, when it gave one.
	text?: string;
	judge?: Judge;
	patch?: Partial<State>;
	context?: Partial<ToolContext>;
}

// send_to on store-front/main's screen, with these words said.
const sendTo = async ({
	utterance,
	ref = CHECKOUT,
	text,
	judge,
	patch = {},
	context = {},
}: SendToParams) => {
	const { tools, actions } = createToolContext(patch);
	const result = await executeTool(
		'send_to',
		{ ref, kind: 'instruction', ...(text ? { text } : {}) },
		{
			...tools,
			...(judge ? { judge } : {}),
			...(utterance === undefined ? {} : { utterance }),
			forwardTo: SCREEN,
			screen: SCREEN,
			...context,
		},
	);

	return { result, actions };
};

// The tool context's sessions, plus these, each idle.
const withSessions = (...refs: string[]): Partial<State> => {
	const { tools } = createToolContext();
	const state = tools.getState();

	return {
		sessions: {
			...state.sessions,
			...Object.fromEntries(
				refs.map((ref) => [
					ref,
					{
						...createSession({ ref, label: ref, branch: '', cwd: '/w', dirs: [], isPinned: false }),
						status: 'idle' as const,
					},
				]),
			),
		},
		order: [...state.order, ...refs],
	};
};

const VM1 = {
	vm1: {
		id: 'vm1',
		host: 'dev@vm1',
		name: 'Build box',
		status: 'connected' as const,
		detail: null,
		since: 0,
	},
};

const sentRefs = (actions: { type: string; ref?: string }[]): (string | undefined)[] =>
	actions.filter((action) => action.type === 'send').map((action) => action.ref);

describe('which session the words name', () => {
	it('a workspace with two worktrees: "checkout" names each of them; the screen gets nothing', async () => {
		for (const ref of [CHECKOUT, 'checkout-api/wrk1']) {
			const { actions } = await sendTo({
				ref,
				utterance: 'Tell checkout to run the tests.',
				patch: withSessions('checkout-api/wrk1'),
			});

			expect(sentRefs(actions)).toEqual([ref]);
		}
	});

	it('the same workspace on two machines, no machine said → either is named', async () => {
		const patch = { ...withSessions('vm1:checkout-api/main'), machines: VM1 };

		for (const ref of [CHECKOUT, 'vm1:checkout-api/main']) {
			const { actions } = await sendTo({
				ref,
				utterance: 'Tell checkout to run the tests.',
				patch,
			});

			expect(sentRefs(actions)).toEqual([ref]);
		}
	});

	it('"vm1 checkout, run the tests" → vm1\'s is sent; this Mac\'s is asked about, never the screen', async () => {
		const patch = { ...withSessions('vm1:checkout-api/main'), machines: VM1 };
		const utterance = 'vm1 checkout, run the tests.';
		const remote = await sendTo({ ref: 'vm1:checkout-api/main', utterance, patch });
		const local = await sendTo({ ref: CHECKOUT, utterance, patch, judge: judgeNever });

		expect(sentRefs(remote.actions)).toEqual(['vm1:checkout-api/main']);
		expect(local.result.ok).toBe(false);
		expect(local.result.content).toContain('which session');
		expect(sentRefs(local.actions)).toEqual([]);
	});

	// A remote called "dev": "restart the dev server" says its name as an ordinary word.
	it('a machine name said as an ordinary word → never the screen: asked which session', async () => {
		const patch = { machines: { dev: { ...VM1.vm1, id: 'dev', name: 'dev' } } };
		const { result, actions } = await sendTo({
			utterance: 'Checkout api, restart the dev server.',
			patch,
		});

		expect(sentRefs(actions)).toEqual([]);
		expect(result.content).toContain('which session');
	});

	it('two names in one sentence, one a display name → the other is still named', async () => {
		const { actions } = await sendTo({
			utterance: 'Tell checkout what Shop Main found.',
			patch: { names: { 'store-front/wrk1': 'Shop Main' } },
		});

		expect(sentRefs(actions)).toEqual([CHECKOUT]);
	});
});

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

	it('described only by its work ("the retry one", which it was asked for) → the screen, like any unnamed send', async () => {
		const { tools } = createToolContext();
		const sessions = tools.getState().sessions;
		const { actions } = await sendTo({
			utterance: 'The retry one, run the tests again.',
			judge: judgeNever,
			patch: {
				sessions: {
					...sessions,
					[CHECKOUT]: {
						...sessions[CHECKOUT]!,
						requests: [{ text: 'Add retry backoff to checkout.', at: 0 }],
					},
				},
			},
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

	it('an inactive session only mentioned → the words stay on the screen, no "For …?"', async () => {
		const said = 'Put it on top of the checkout api branch.';
		const { actions } = await sendTo({ utterance: said, patch: { active: [SCREEN] } });

		expect(actions).toEqual([expect.objectContaining({ type: 'send', ref: SCREEN })]);
	});

	it('an inactive session spoken to → its words queued for it, "Activate it?"', async () => {
		const said = 'Checkout api, run the tests.';
		const { actions } = await sendTo({
			utterance: said,
			judge: judgeWith({ spoken_to: 'yes' }),
			patch: { active: [SCREEN] },
		});

		expect(actions).toEqual([
			{ type: 'send', ref: CHECKOUT, text: said, isSpoken: true },
			{ type: 'offer_switch', ref: CHECKOUT, kind: 'activate' },
		]);
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

	it('a bare "yes" to a session waiting on a permission, unnamed → the answer tool is named, nothing sent', async () => {
		const { result, actions } = await sendTo({
			utterance: 'Yes.',
			patch: {
				asks: [
					{
						id: 'p1',
						ref: CHECKOUT,
						at: 0,
						kind: 'permission',
						toolName: 'Bash',
						summary: 'run git push',
						input: {},
						suggestions: [],
					},
				],
			},
		});

		expect(result.ok).toBe(false);
		expect(result.content).toContain('use the answer tool');
		expect(actions).toEqual([]);
	});

	it('earlier words pointed at a session not named ("I meant that for the other one") → ask which, nothing sent again', async () => {
		const { result, actions } = await sendTo({
			utterance: 'Sorry, I meant that for the other one.',
			judge: judgeWith({ take_back_before: 'no' }),
			context: { recentUtterances: ['Run the release checklist.'] },
			text: 'Run the release checklist.',
		});

		expect(result.ok).toBe(false);
		expect(result.content).toContain('say which session');
		expect(actions).toEqual([]);
	});

	it('no words to check (an internal call) → sent as chosen', async () => {
		const { actions } = await sendTo({
			utterance: undefined,
			judge: judgeNever,
			text: 'Run the tests.',
		});

		expect(sentRefs(actions)).toEqual([CHECKOUT]);
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

describe('the answer fallback: words for a session that asked nothing pending', () => {
	// checkout ended its turn on a question; heard: it was said aloud before the developer spoke.
	const asking = (isHeard: boolean): Partial<State> => {
		const { tools } = createToolContext();
		const sessions = tools.getState().sessions;

		return {
			sessions: {
				...sessions,
				[CHECKOUT]: {
					...sessions[CHECKOUT]!,
					status: 'idle',
					needsUser: { text: 'Deploy the fix to staging?', at: -10_000 },
				},
			},
			spoken: isHeard
				? [
						{
							id: 'asked',
							text: 'checkout api, main asks: deploy the fix to staging?',
							source: 'narrator',
							at: -9_000,
							endedAt: -6_000,
							ref: CHECKOUT,
							isAsking: true,
						},
					]
				: [],
		};
	};

	const answer = async (utterance: string, patch: Partial<State>) => {
		const { tools, actions } = createToolContext(patch);
		const result = await executeTool(
			'answer',
			{ ref: CHECKOUT, decision: 'yes', text: '' },
			{ ...tools, utterance, forwardTo: SCREEN, screen: SCREEN, heardFrom: 0 },
		);

		return { result, actions };
	};

	it('its question heard → an unnamed "Yes." is its answer: sent there', async () => {
		const { actions } = await answer('Yes.', asking(true));

		expect(sentRefs(actions)).toEqual([CHECKOUT]);
	});

	it('its question never heard → an unnamed "Yes." is for the screen', async () => {
		const { actions } = await answer('Yes.', asking(false));

		expect(actions).toEqual([expect.objectContaining({ type: 'send', ref: SCREEN, text: 'Yes.' })]);
	});

	it('named but only mentioned → "For …?", the words held', async () => {
		const said = 'Put it on top of the checkout api branch.';
		const { result, actions } = await answer(said, asking(false));

		expect(result).toMatchObject({ ok: true, note: 'asked which session' });
		expect(actions).toEqual([{ type: 'ask_which', ref: CHECKOUT, screen: SCREEN, text: said }]);
	});
});
