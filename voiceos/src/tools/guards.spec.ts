// Every guard that asks the judge, on each of its answers: yes, no and unclear, where unclear is
// the side that never approves, never drops the developer's words and never acts on a guess. The
// language-neutral fast paths are pinned with a judge that fails the spec if it is asked at all.
import { describe, expect, it } from 'bun:test';
import { judgeNever, judgeWith } from '../../test/support/english-judge.js';
import { createToolContext, INSTRUCTION_ACK } from '../../test/support/tool-context.js';
import type { Judge, JudgeKey } from '../judge/judge.js';
import {
	QUESTION_UNHEARD_MS,
	SWITCH_OFFER_MS,
	type ListenMode,
	type PendingAsk,
	type State,
} from '../shared/protocol.js';
import { TAKEN_BACK } from './queued.js';
import { isMisroutedToSetup } from './send.js';
import { executeTool, type ToolContext } from './tools.js';

const SCREEN = 'store-front/main';

const permission: PendingAsk = {
	id: 'p1',
	ref: SCREEN,
	at: 1,
	kind: 'permission',
	toolName: 'Bash',
	summary: 'run git push',
	input: {},
	suggestions: [],
};

const clear: PendingAsk = {
	id: 'c1',
	ref: SCREEN,
	at: 0,
	kind: 'command',
	command: 'clear',
	text: '/clear',
};

const question: PendingAsk = {
	id: 'q1',
	ref: SCREEN,
	at: 1,
	kind: 'question',
	input: {},
	questions: [
		{
			question: 'Which database?',
			multiSelect: false,
			options: [{ label: 'Postgres' }, { label: 'SQLite' }],
		},
	],
};

interface ToolsForParams {
	judge: Judge;
	utterance?: string;
	patch?: Partial<State>;
}

const toolsFor = ({ judge, utterance, patch = {} }: ToolsForParams) => {
	const { tools, actions } = createToolContext(patch);
	const context: ToolContext = {
		...tools,
		judge,
		forwardTo: SCREEN,
		screen: SCREEN,
		...(utterance === undefined ? {} : { utterance }),
	};

	return { tools: context, actions };
};

const withStatus = (status: 'running' | 'blocked'): Partial<State> => {
	const { tools } = createToolContext();
	const sessions = tools.getState().sessions;

	return { sessions: { ...sessions, [SCREEN]: { ...sessions[SCREEN]!, status } } };
};

describe('approval: a yes the model heard is checked', () => {
	const answerYes = (ask: PendingAsk, judge: Judge) => {
		const { tools, actions } = toolsFor({
			judge,
			utterance: 'Ja, mach das.',
			patch: { asks: [ask] },
		});

		return executeTool(
			'answer',
			{ ref: SCREEN, decision: 'yes', text: '' },
			{ ...tools, asks: [ask] },
		).then((result) => ({ result, actions }));
	};

	it('a permission asks "approves": yes → allowed; no or unclear → nothing approved', async () => {
		const allowed = await answerYes(permission, judgeWith({ approves: 'yes' }));

		expect(allowed.actions).toEqual([
			{ type: 'answer_permission', askId: 'p1', decision: 'allow' },
		]);

		for (const answer of ['no', 'unclear']) {
			const refused = await answerYes(permission, judgeWith({ approves: answer }));

			expect(refused.result.ok).toBe(false);
			expect(refused.actions).toEqual([]);
		}
	});

	it('a held /clear asks the stricter "approves_plainly": a yes with a "not" in it approves no /clear', async () => {
		// "approves" would say yes: only the plain question is asked for a command.
		const refused = await answerYes(clear, judgeWith({ approves_plainly: 'no' }));
		const unclear = await answerYes(clear, judgeWith({ approves_plainly: 'unclear' }));
		const approved = await answerYes(clear, judgeWith({ approves_plainly: 'yes' }));

		expect(refused.actions).toEqual([]);
		expect(unclear.actions).toEqual([]);
		expect(approved.actions).toEqual([{ type: 'answer_command', askId: 'c1', isApproved: true }]);
	});
});

describe('mute', () => {
	const mute = async (utterance: string, judge: Judge) => {
		let isMuted = false;
		const { tools } = toolsFor({ judge, utterance });
		const result = await executeTool(
			'mute',
			{},
			{
				...tools,
				mute: () => {
					isMuted = true;
				},
			},
		);

		return { result, isMuted };
	};

	it('short words: "Tiho." mutes on yes or unclear; a bare "Stop." (the judge hears stop) does not', async () => {
		expect((await mute('Tiho.', judgeWith({ mute_only: 'yes' }))).isMuted).toBe(true);
		expect((await mute('Tiho.', judgeWith({ mute_only: 'unclear' }))).isMuted).toBe(true);
		expect((await mute('Stop.', judgeWith({ mute_only: 'stop' }))).isMuted).toBe(false);
	});

	it('longer: mute_only yes → muted; no or unclear → not muted', async () => {
		const said = 'Kannst du bitte still sein?';

		expect((await mute(said, judgeWith({ mute_only: 'yes' }))).isMuted).toBe(true);

		for (const answer of ['no', 'unclear']) {
			const { result, isMuted } = await mute(
				said,
				judgeWith({ mute_only: answer, about_listening: 'no', listen_mode: 'unclear' }),
			);

			expect(isMuted).toBe(false);
			expect(result).toMatchObject({ ok: false, content: 'not a mute request; do nothing more' });
		}
	});

	it('not a mute but about listening ("hör auf zuzuhören") → not muted; listening changed as asked', async () => {
		const { result, isMuted } = await mute(
			'Hör auf zuzuhören.',
			judgeWith({ mute_only: 'no', about_listening: 'yes', listen_mode: 'off' }),
		);

		expect(isMuted).toBe(false);
		expect(result).toMatchObject({
			ok: true,
			content: 'listening is now push; Voice OS said so',
			recordAs: { name: 'hands_free', input: { mode: 'push' } },
		});
	});

	it('about listening, but which way unclear → nothing changed', async () => {
		const { result, isMuted } = await mute(
			'Hör auf zuzuhören.',
			judgeWith({ mute_only: 'no', about_listening: 'yes', listen_mode: 'unclear' }),
		);

		expect(isMuted).toBe(false);
		expect(result.ok).toBe(false);
	});
});

describe('interrupt', () => {
	const interrupt = async (utterance: string, judge: Judge) => {
		const { tools, actions } = toolsFor({ judge, utterance, patch: withStatus('running') });
		const result = await executeTool('interrupt', { ref: SCREEN }, tools);

		return { result, actions };
	};

	it('one word ("Stopp.", "stop") is a stop in any language: interrupted, the judge not asked', async () => {
		for (const said of ['Stopp.', 'stop']) {
			expect((await interrupt(said, judgeNever)).actions).toEqual([
				{ type: 'interrupt', ref: SCREEN },
			]);
		}
	});

	it('more words: about listening → not interrupted; says what instead → not interrupted', async () => {
		const listening = await interrupt(
			'Hör auf zuzuhören.',
			judgeWith({ about_listening: 'yes', says_instead: 'no' }),
		);
		const redirect = await interrupt(
			'Stopp das und fix den Login.',
			judgeWith({ about_listening: 'no', says_instead: 'yes' }),
		);

		expect(listening.actions).toEqual([]);
		expect(listening.result.content).toContain('Use hands_free');
		expect(redirect.actions).toEqual([]);
		expect(redirect.result.content).toContain('kind redirect');
	});

	it('both unclear → interrupted: a stop the developer asked for is never held back on a guess', async () => {
		const { actions } = await interrupt(
			'Warte mal kurz.',
			judgeWith({ about_listening: 'unclear', says_instead: 'unclear' }),
		);

		expect(actions).toEqual([{ type: 'interrupt', ref: SCREEN }]);
	});
});

describe('hands_free', () => {
	const setTo = async (answer: string) => {
		const modes: ListenMode[] = [];
		const { tools } = toolsFor({
			judge: judgeWith({ listen_mode: answer }),
			utterance: 'Nehaj poslušati.',
		});
		const result = await executeTool(
			'hands_free',
			{ mode: 'hands-free' },
			{
				...tools,
				setListenMode: (mode) => {
					modes.push(mode);

					return 'changed';
				},
			},
		);

		return { result, modes };
	};

	it('the judge, not the model, decides the mode: "off" is push to talk, and is remembered so', async () => {
		const off = await setTo('off');

		expect(off.modes).toEqual(['push']);
		// The model asked for hands-free: what is remembered is what was applied.
		expect(off.result.recordAs).toEqual({ name: 'hands_free', input: { mode: 'push' } });
		expect((await setTo('on-demand')).modes).toEqual(['on-demand']);
	});

	it('unclear → not changed, whatever mode the model chose', async () => {
		const { result, modes } = await setTo('unclear');

		expect(modes).toEqual([]);
		expect(result.ok).toBe(false);
	});
});

describe('queued_message drop', () => {
	// Words already delivered and being worked on: a take-back tells the session; a misroute also stops it.
	const delivered = (judge: Judge, utterance: string) => {
		const { tools, actions } = toolsFor({ judge, utterance, patch: withStatus('running') });
		const state = tools.getState();

		state.sessions[SCREEN] = { ...state.sessions[SCREEN]!, currentSendId: 'running-1' };
		state.lastSpokenSend = { ref: SCREEN, id: 'running-1', text: 'x', at: 1 };

		return { tools, actions };
	};

	const drop = async (answers: Partial<Record<JudgeKey, string>>, utterance: string) => {
		const { tools, actions } = delivered(judgeWith(answers), utterance);

		await executeTool('queued_message', { ref: SCREEN, action: 'drop' }, tools);

		return actions;
	};

	it('a bare take-back (judge yes) → told, and left to finish its turn', async () => {
		expect(await drop({ take_back: 'yes', misrouted: 'no' }, 'Vergiss das.')).toEqual([
			{ type: 'send', ref: SCREEN, text: TAKEN_BACK },
		]);
	});

	it('said to be for someone else, no session named (judge misrouted yes) → stopped and told', async () => {
		expect(
			await drop({ take_back: 'no', misrouted: 'yes' }, 'Das war nicht für dich gemeint.'),
		).toEqual([
			{ type: 'interrupt', ref: SCREEN, isCorrection: true },
			{ type: 'send', ref: SCREEN, text: TAKEN_BACK },
		]);
	});

	it('take_back and misrouted unclear → the words go to the session as a correction, never lost', async () => {
		const actions = await drop(
			{ take_back: 'unclear', misrouted: 'unclear' },
			'Nein, nimm die andere Datei.',
		);

		expect(actions).toEqual([
			expect.objectContaining({ type: 'send', text: 'Nein, nimm die andere Datei.' }),
		]);
	});

	it('another session named → a misroute without asking whether it was one', async () => {
		const actions = await drop({ take_back: 'no' }, 'Das war für checkout api main.');

		expect(actions).toEqual([
			{ type: 'interrupt', ref: SCREEN, isCorrection: true },
			{ type: 'send', ref: SCREEN, text: TAKEN_BACK },
		]);
	});
});

describe('answering a question with a question', () => {
	const answerWith = async (utterance: string, judge: Judge) => {
		const { tools, actions } = toolsFor({ judge, utterance, patch: { asks: [question] } });
		const result = await executeTool(
			'answer',
			{ ref: SCREEN, decision: 'choose', text: 'SQLite' },
			{ ...tools, asks: [question] },
		);

		return { result, actions };
	};

	it('a label said back ("SQLite?") → the pick, the judge not asked', async () => {
		// The words decide, not the model's choice: a label said back is never a question.
		const { actions } = await answerWith('SQLite?', judgeNever);

		expect(actions).toEqual([expect.objectContaining({ type: 'answer_question' })]);
	});

	it('"Die zweite?" (no label named): the judge hears a pick → answered; unclear → forwarded as a question', async () => {
		const picked = await answerWith('Die zweite?', judgeWith({ option_reply: 'pick' }));
		const unclear = await answerWith('Die zweite?', judgeWith({ option_reply: 'unclear' }));

		expect(picked.actions).toEqual([expect.objectContaining({ type: 'answer_question' })]);
		expect(unclear.actions).toEqual([
			expect.objectContaining({ type: 'send', text: 'Die zweite?', ack: { kind: 'question' } }),
		]);
	});

	it('"Can you go into crew session?" beside an option "Crew project" → no answer: the words are for something else', async () => {
		const other = await answerWith(
			'Can you go into crew session?',
			judgeWith({ option_reply: 'other' }),
		);

		expect(other.actions).toEqual([]);
		expect(other.result.ok).toBe(false);
		expect(other.result.content).toContain('choose none of the options');
	});
});

describe('sends', () => {
	const forward = async (utterance: string, judge: Judge, patch: Partial<State> = {}) => {
		const { tools, actions } = toolsFor({ judge, utterance, patch });
		const result = await executeTool('forward', { kind: 'instruction' }, tools);

		return { result, actions };
	};

	it('words to an idle session with nothing open → sent, the judge not asked', async () => {
		const { actions } = await forward('Führ die Tests aus.', judgeNever);

		expect(actions).toEqual([
			{ type: 'send', ref: SCREEN, text: 'Führ die Tests aus.', ack: INSTRUCTION_ACK },
		]);
	});

	it('more than a few words while something waits → never asked whether they are a bare answer', async () => {
		const { actions } = await forward('Ja, und dann führ bitte auch die Tests aus.', judgeNever, {
			asks: [permission],
		});

		expect(actions).toEqual([expect.objectContaining({ type: 'send' })]);
	});

	describe("a yes after Voice OS's offer to fix this session's servers", () => {
		const offer = (at: number): Partial<State> => ({
			devOffer: { ref: SCREEN, servers: ['web'], at },
		});

		it('fresh, a short yes (judge approves) → not sent: dev_offer answers it', async () => {
			const { result, actions } = await forward(
				'Ja, mach.',
				judgeWith({ approves: 'yes' }),
				offer(0),
			);

			expect(actions).toEqual([]);
			expect(result.content).toContain('call dev_offer');
		});

		it('judge unclear, or more than a few words → sent to the session', async () => {
			const unclear = await forward('Ja, mach.', judgeWith({ approves: 'unclear' }), offer(0));
			const long = await forward('Ja, und schau dir auch die Logs an.', judgeNever, offer(0));

			expect(unclear.actions).toEqual([expect.objectContaining({ type: 'send' })]);
			expect(long.actions).toEqual([expect.objectContaining({ type: 'send' })]);
		});

		it('an offer for another session, or older than half an hour → the judge not asked', async () => {
			const elsewhere = await forward('Ja, mach.', judgeNever, {
				devOffer: { ref: 'checkout-api/main', servers: ['api'], at: 0 },
			});
			const { tools, actions } = toolsFor({
				judge: judgeNever,
				utterance: 'Ja, mach.',
				patch: offer(0),
			});

			await executeTool('forward', { kind: 'instruction' }, { ...tools, now: () => 31 * 60_000 });

			expect(elsewhere.actions).toEqual([expect.objectContaining({ type: 'send' })]);
			expect(actions).toEqual([expect.objectContaining({ type: 'send' })]);
		});
	});

	it('a busy session: the kernel says how (deliver), the judge is never asked', async () => {
		const running = withStatus('running');
		const aside = toolsFor({
			judge: judgeNever,
			utterance: 'Übrigens, welcher Branch?',
			patch: running,
		});
		const queued = toolsFor({
			judge: judgeNever,
			utterance: 'Frag es, welcher Branch?',
			patch: running,
		});

		await executeTool('forward', { kind: 'instruction', deliver: 'aside' }, aside.tools);
		await executeTool('forward', { kind: 'question', deliver: 'queue' }, queued.tools);

		expect(aside.actions).toEqual([expect.objectContaining({ type: 'send', aside: true })]);
		expect(queued.actions).toEqual([expect.not.objectContaining({ aside: true })]);
	});
});

describe('words for setup from another screen', () => {
	const misrouted = (answer: string) => {
		const base = createToolContext().tools.getState();
		const state: State = {
			...base,
			sessions: {
				...base.sessions,
				'checkout-api/main': { ...base.sessions['checkout-api/main']!, isPinned: true },
			},
		};

		return isMisroutedToSetup({
			judge: judgeWith({ for_setup: answer }),
			state,
			ref: 'checkout-api/main',
			forwardTo: SCREEN,
			utterance: 'Installier Voice OS neu.',
		});
	};

	it('refused only when the judge says they are not for setup; unclear lets them through', async () => {
		// Setup would say it cannot help; words lost on a guess cannot be got back.
		expect(await misrouted('no')).toBe(true);
		expect(await misrouted('yes')).toBe(false);
		expect(await misrouted('unclear')).toBe(false);
	});
});

describe('a bare answer sent as words', () => {
	const forward = async (utterance: string, judge: Judge, patch: Partial<State>) => {
		const { tools, actions } = toolsFor({ judge, utterance, patch });
		const result = await executeTool('forward', { kind: 'instruction' }, tools);

		return { result, actions };
	};

	it('"Nein." right after "Switch to …?": refuses yes → an answer to Voice OS, nothing sent', async () => {
		const offer = { switchOffer: { ref: 'checkout-api/main', at: 0 } };
		const refused = await forward('Nein.', judgeWith({ refuses: 'yes' }), offer);

		expect(refused.actions).toEqual([]);
		expect(refused.result.ok).toBe(false);

		// Unclear: the words reach the session rather than vanish.
		for (const answer of ['no', 'unclear']) {
			const sent = await forward(
				'Nein.',
				judgeWith({ refuses: answer, bare_answer: 'yes', approves: 'no' }),
				offer,
			);

			expect(sent.actions).toEqual([expect.objectContaining({ type: 'send', text: 'Nein.' })]);
		}

		const long = await forward('Nein, schau dir lieber die Logs an.', judgeNever, offer);

		expect(long.actions).toEqual([expect.objectContaining({ type: 'send' })]);
	});

	it('"Ja." forwarded while a permission waits: bare_answer yes → refused (the answer tool decides it)', async () => {
		const waiting = { asks: [permission] };
		const refused = await forward('Ja.', judgeWith({ bare_answer: 'yes' }), waiting);
		const unclear = await forward('Ja.', judgeWith({ bare_answer: 'unclear' }), waiting);

		expect(refused.actions).toEqual([]);
		expect(refused.result.content).toContain('use the answer tool');
		// The words go through and decline it with themselves: nothing is approved on a guess.
		expect(unclear.actions).toEqual([expect.objectContaining({ type: 'send', text: 'Ja.' })]);
	});
});

describe('which session the words name', () => {
	it('stop with only "this one" said, this_session unclear → nothing stopped', async () => {
		const { tools, actions } = toolsFor({
			judge: judgeWith({ this_session: 'unclear' }),
			utterance: 'Beende die hier.',
		});
		const result = await executeTool('stop_session', { ref: SCREEN }, tools);

		expect(result.ok).toBe(false);
		expect(actions).toEqual([]);
	});

	it('start with more_than_start unclear → started, no hint to forward the rest', async () => {
		const { tools } = toolsFor({
			judge: judgeWith({ more_than_start: 'unclear' }),
			utterance: 'Starte checkout api, bitte schnell.',
		});
		const result = await executeTool('start_session', { ref: 'checkout-api/main' }, tools);

		expect(result).toMatchObject({ ok: true, content: 'starting checkout-api/main' });
	});
});

describe('a yes to Voice OS\'s own "Want me to ask it?"', () => {
	const ASKED = 'Okay. How long do you think checkout is going to take?';

	const sendYes = async (judge: Judge, utterance = 'Yes.') => {
		const { tools, actions } = toolsFor({ judge, utterance });

		await executeTool(
			'send_to',
			{ ref: 'checkout-api/main', kind: 'question', text: 'How long will it take?' },
			{ ...tools, askedBack: ASKED },
		);

		return actions.find((action) => action.type === 'send');
	};

	it('a plain yes (judge approves) → the question it offered to ask goes, as the developer said it', async () => {
		expect(await sendYes(judgeWith({ approves: 'yes', take_back_before: 'no' }))).toMatchObject({
			ref: 'checkout-api/main',
			text: ASKED,
		});
	});

	it('not a clear yes, or more than a few words → the words as said, never the old question', async () => {
		const unclear = await sendYes(judgeWith({ approves: 'unclear', take_back_before: 'no' }));
		const long = await sendYes(
			judgeWith({ take_back_before: 'no' }),
			'Yes, and also ask it why the build is red.',
		);

		expect(unclear?.text).toBe('Yes.');
		expect(long?.text).toBe('Yes, and also ask it why the build is red.');
	});
});

describe('a yes to Voice OS\'s "Switch to …?"', () => {
	const offer = { switchOffer: { ref: 'checkout-api/main', at: 0, heardAt: 1_000 } };

	it('forwarded as words → not sent: it answers the offer, switch_view is named', async () => {
		const { tools, actions } = toolsFor({
			judge: judgeWith({ refuses: 'no', bare_answer: 'yes', approves: 'yes' }),
			utterance: 'Ja.',
			patch: offer,
		});
		const result = await executeTool(
			'forward',
			{ kind: 'instruction' },
			{ ...tools, heardFrom: 5_000 },
		);

		expect(actions).toEqual([]);
		expect(result.content).toContain('call switch_view checkout-api/main');
	});

	it('"yes, push it" while the offer is open → words for the session, sent (to the offered one or the screen)', async () => {
		for (const [tool, input] of [
			['send_to', { ref: 'checkout-api/main', kind: 'instruction' }],
			['forward', { kind: 'instruction' }],
		] as const) {
			const { tools, actions } = toolsFor({
				judge: judgeWith({ refuses: 'no', bare_answer: 'no', take_back_before: 'no' }),
				utterance: 'Yes, push it.',
				patch: offer,
			});

			await executeTool(tool, input, { ...tools, heardFrom: 5_000 });

			expect(actions).toEqual([expect.objectContaining({ type: 'send', text: 'Yes, push it.' })]);
		}
	});

	it('past its window, or never heard and given up on → a bare yes is words again', async () => {
		const late = toolsFor({ judge: judgeNever, utterance: 'Ja.', patch: offer });
		const unheard = toolsFor({
			judge: judgeNever,
			utterance: 'Ja.',
			patch: { switchOffer: { ref: 'checkout-api/main', at: 0 } },
		});

		await executeTool(
			'forward',
			{ kind: 'instruction' },
			{ ...late.tools, heardFrom: 1_000 + SWITCH_OFFER_MS },
		);
		await executeTool(
			'forward',
			{ kind: 'instruction' },
			{ ...unheard.tools, heardFrom: QUESTION_UNHEARD_MS },
		);

		expect(late.actions).toEqual([expect.objectContaining({ type: 'send', text: 'Ja.' })]);
		expect(unheard.actions).toEqual([expect.objectContaining({ type: 'send', text: 'Ja.' })]);
	});

	it('a yes said before the offer was made → words for the session, sent', async () => {
		const { tools, actions } = toolsFor({
			judge: judgeWith({ take_back_before: 'no' }),
			utterance: 'Ja.',
			patch: { switchOffer: { ref: 'checkout-api/main', at: 5_000, heardAt: 6_000 } },
		});

		await executeTool('forward', { kind: 'instruction' }, { ...tools, heardFrom: 4_000 });

		expect(actions).toEqual([expect.objectContaining({ type: 'send', text: 'Ja.' })]);
	});

	it('judged at the moment it was said: a kernel turn that ends past the window still counts', async () => {
		const { tools, actions } = toolsFor({
			judge: judgeWith({ refuses: 'no', bare_answer: 'yes', approves: 'yes' }),
			utterance: 'Ja.',
			patch: offer,
		});

		await executeTool(
			'forward',
			{ kind: 'instruction' },
			{ ...tools, heardFrom: 5_000, now: () => 12_000 },
		);

		expect(actions).toEqual([]);
	});
});

describe('a question only announced, while Voice OS offers the switch to it', () => {
	const held = (): Partial<State> => {
		const { tools } = createToolContext();
		const sessions = tools.getState().sessions;

		return {
			switchOffer: { ref: 'checkout-api/main', at: 0, heardAt: 1_000 },
			sessions: {
				...sessions,
				'checkout-api/main': {
					...sessions['checkout-api/main']!,
					status: 'blocked',
					heldLine: { id: 'h1', at: 0, missed: 0, isAnnounced: true, kind: 'ask', askId: 'q9' },
				},
			},
		};
	};

	it('a bare yes the kernel took as its answer → switched there instead, its question plays', async () => {
		const { tools, actions } = toolsFor({
			judge: judgeWith({ bare_answer: 'yes', approves: 'yes', refuses: 'no' }),
			utterance: 'Ja.',
			patch: held(),
		});
		const result = await executeTool(
			'answer',
			{ ref: 'checkout-api/main', decision: 'yes', text: '' },
			{ ...tools, heardFrom: 2_000 },
		);

		expect(actions).toEqual([
			{ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' }, announce: true },
		]);
		expect(result.ok).toBe(true);
	});

	it('an instruction for it → not dropped in silence: the kernel is told to say its question comes first', async () => {
		const { tools, actions } = toolsFor({
			judge: judgeWith({ bare_answer: 'no', refuses: 'no', take_back_before: 'no' }),
			utterance: 'Tell it to use staging.',
			patch: held(),
		});
		const result = await executeTool(
			'answer',
			{ ref: 'checkout-api/main', decision: 'yes', text: '' },
			{ ...tools, heardFrom: 2_000 },
		);

		expect(actions).toEqual([]);
		expect(result.ok).toBe(false);
		expect(result.content).toContain('its question comes first');
	});
});
