// The design's conversations, heard end to end: the real store, kernel, router, narrator and voice,
// with only the model scripted. Each list is what the developer hears, their own words as "> …".
import { describe, expect, it } from 'bun:test';
import { configureLog } from '../log.js';
import { createConversation, reply, toolUse } from '../../test/support/conversation.js';
import { SWITCH_OFFER_MS, TARGET_ASK_MS, type PendingAsk } from '../shared/protocol.js';
import { englishJudge } from '../../test/support/english-judge.js';
import type { Judge } from '../judge/judge.js';
import { applyPageAction } from './page-actions.js';

configureLog({ quiet: true });

const REFS = ['store-front/main', 'checkout-api/main', 'signals/main'];

// Checkout finishes while the developer looks elsewhere; its update is said in the meanwhile line.
const UPDATE =
	'The retry backoff now doubles from one second up to thirty, and every retry test passes again.';
const MEANWHILE_LINE =
	'Meanwhile, checkout api, main said: The retry backoff now doubles from one second up to thirty, and every retry test passes again.';

const hearUpdate = async (convo: ReturnType<typeof createConversation>): Promise<void> => {
	await convo.answer('checkout-api/main', UPDATE);
	await convo.wait(9_000);
};

// The English judge, held on one question once armed: the words are still being read when the
// question's wait runs out.
const createHeldJudge = (key: string) => {
	let gate: Promise<void> | null = null;
	let release = (): void => undefined;

	const judge: Judge = async (params) => {
		if (gate && params.key === key) {
			await gate;
		}

		return englishJudge(params);
	};

	return {
		judge,
		arm: () => {
			gate = new Promise((resolve) => {
				release = resolve;
			});
		},
		release: () => release(),
	};
};

describe('conversations', () => {
	it('the screen session asks; answered on the page before its line is heard → the line is never heard', async () => {
		const ask = (id: string): PendingAsk => ({
			id,
			ref: 'store-front/main',
			at: 1,
			kind: 'permission',
			toolName: 'Bash',
			summary: 'run git push',
			input: { command: 'git push' },
			suggestions: [],
		});
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main');

		convo.store.dispatch({ type: 'ask_opened', ask: ask('p1') });
		await convo.listen();
		expect(convo.heard).toEqual([expect.stringContaining('git push')]);
		const heardOpen = convo.heard.length;

		convo.store.dispatch({ type: 'answer_permission', askId: 'p1', decision: 'allow' });
		convo.store.dispatch({ type: 'ask_opened', ask: ask('p2') });
		convo.store.dispatch({ type: 'ask_closed', askId: 'p2' });
		await convo.listen();

		expect(convo.heard.slice(heardOpen).filter((line) => line.includes('git push'))).toEqual([]);
	});

	it('a question to a session named and spoken to → sent there, the switch offered; its short answer is heard with its name', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
		await convo.say('checkout api, is the build green?');
		await convo.answer('checkout-api/main', 'Yes, all 214 tests pass.');

		expect(convo.heard).toEqual([
			'> checkout api, is the build green?',
			'Sent to checkout api, main. Switch there?',
			'checkout api, main: Yes, all 214 tests pass.',
		]);
	});
	it('with the instant ack on: a question gets "One sec." while the kernel decides, never a yes; the worded "Sent to …", then the answer', async () => {
		const convo = createConversation({
			refs: REFS,
			view: 'store-front/main',
			hasInstantAck: true,
			writeFollowUp: async ({ facts }) =>
				facts.kind === 'sent' ? `Passed that to ${facts.label}. Want to go there?` : null,
		});
		await convo.startSessions('store-front/main', 'checkout-api/main');
		const model = convo.holdModel();

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
		const saying = convo.say('checkout api, is the build green?');
		await model.reached;
		await convo.wait(600);
		model.release();
		await saying;
		await convo.answer('checkout-api/main', 'Yes, all 214 tests pass.');

		expect(convo.heard).toEqual([
			'> checkout api, is the build green?',
			expect.stringMatching(/^\[warm\] (One sec|Let me check)\.$/),
			'Passed that to checkout api, main. Want to go there?',
			'checkout api, main: Yes, all 214 tests pass.',
		]);
		expect(convo.store.state.switchOffer?.ref).toBe('checkout-api/main');
	});

	it('a follow-up that names no session → for the screen: a send_to elsewhere is refused and the kernel forwards it', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
		await convo.say('checkout api, is the build green?');
		await convo.answer('checkout-api/main', 'Yes, all 214 tests pass.');
		await convo.wait(SWITCH_OFFER_MS + 1_000);

		convo.script(
			[toolUse('t2', 'send_to', { ref: 'checkout-api/main', kind: 'question' })],
			[toolUse('t3', 'forward', { kind: 'question' })],
		);
		await convo.say('And the lint?');

		expect(convo.heard.slice(-1)).toEqual(['> And the lint?']);
		expect(convo.inputs).toContainEqual(
			expect.objectContaining({ type: 'send', ref: 'store-front/main', text: 'And the lint?' }),
		);
		expect(convo.inputs).not.toContainEqual(
			expect.objectContaining({ type: 'send', ref: 'checkout-api/main', text: 'And the lint?' }),
		);
	});
	it('words said on a session\'s screen, then clicked away while they are read → no "Sent to", no offer; its reply comes in the meanwhile line', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		const model = convo.holdModel();

		convo.script([toolUse('t1', 'forward', { kind: 'instruction' })]);
		const saying = convo.say('Run the tests.');
		await model.reached;
		await convo.show('checkout-api/main');
		model.release();
		await saying;

		expect(convo.inputs).toContainEqual(
			expect.objectContaining({
				type: 'send',
				ref: 'store-front/main',
				text: 'Run the tests.',
				saidOn: 'store-front/main',
			}),
		);
		expect(convo.heard).toEqual(['> Run the tests.']);
		expect(convo.store.state.switchOffer).toBeNull();

		// Long: said at once only on screen.
		await convo.answer(
			'store-front/main',
			'The whole suite ran in four minutes, all 214 tests pass, and the flaky cart test is gone.',
		);
		expect(convo.heard).toEqual(['> Run the tests.']);
		await convo.wait(9_000);

		expect(convo.heard).toEqual([
			'> Run the tests.',
			'Meanwhile, store front, main said: The whole suite ran in four minutes, all 214 tests pass, and the flaky cart test is gone. Switch there?',
		]);
	});

	it('switch by voice, then go back: each move is said, and a stopped session is passed over', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main', 'signals/main');

		convo.script([toolUse('t1', 'switch_view', { ref: 'checkout-api/main' })]);
		await convo.say('Switch to checkout api.');
		convo.script([toolUse('t2', 'switch_view', { ref: 'signals/main' })]);
		await convo.say('Now signals.');
		convo.store.dispatch({ type: 'worker_exited', ref: 'checkout-api/main', error: null });
		convo.script([toolUse('t3', 'go_back', {})]);
		await convo.say('Go back.');

		expect(convo.heard).toEqual([
			'> Switch to checkout api.',
			'Switching to checkout api, main.',
			'> Now signals.',
			'Switching to signals, main.',
			'> Go back.',
			'checkout api, main stopped. Back to store front, main.',
		]);
		expect(convo.store.state.view).toEqual({
			kind: 'session',
			ref: 'store-front/main',
			from: 'active',
		});
	});

	// Debug note 31: the switch says it, and the model's reply says it again.
	it('a switch the model also says in its reply → "Switching to …" heard once', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');

		// A switch is silent: the model's text beside it is the reply, with no second call.
		convo.script([
			toolUse('t1', 'switch_view', { ref: 'checkout-api/main' }),
			reply('Switching to checkout api, main.'),
		]);
		await convo.say('Switch to checkout api.');
		await convo.wait(2_000);

		expect(convo.heard).toEqual(['> Switch to checkout api.', 'Switching to checkout api, main.']);
	});

	it('two quick sends to the same session → each "Sent to …" heard', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Checkout api, run the tests.');
		convo.script([toolUse('t2', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Checkout api, and the linter.');

		expect(
			convo.heard.filter((line) => line.startsWith('Sent to checkout api, main')),
		).toHaveLength(2);
	});

	it('words that name another session without speaking to it → "For …?"; no keeps them on the screen', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Okay, can you do a deep review of the checkout api changes?');
		await convo.say('No.');

		expect(convo.heard).toEqual([
			'> Okay, can you do a deep review of the checkout api changes?',
			'For checkout api, main?',
			'> No.',
			'Kept on store front, main.',
		]);
		expect(convo.inputs).toContainEqual(
			expect.objectContaining({
				type: 'send',
				ref: 'store-front/main',
				text: 'Okay, can you do a deep review of the checkout api changes?',
			}),
		);
	});
	it('"For …?" open, and the developer types "no" into the session\'s box → typed to that session, not the answer', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Can you review all of the checkout api changes?');

		await convo.type('no');

		expect(convo.store.state.targetAsk?.ref).toBe('checkout-api/main');
		expect(convo.inputs).toContainEqual(
			expect.objectContaining({ type: 'send', ref: 'store-front/main', text: 'no' }),
		);
	});

	it('"For …?" asked while the developer was already saying something else → those words are not its answer', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Can you review all of the checkout api changes?');

		convo.script([toolUse('t2', 'forward', { kind: 'instruction' })]);
		await convo.say('Yes.', { startedAgoMs: 5_000 });

		// Still open for an answer said after it: this yes began before the question existed.
		expect(convo.store.state.targetAsk?.ref).toBe('checkout-api/main');
	});

	it('"For …?" that played in no tab → let go at once, the words kept on the screen', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.store.dispatch({
			type: 'ask_which',
			ref: 'checkout-api/main',
			screen: 'store-front/main',
			text: 'review all of this',
		});
		const asked = convo.store.dispatch({
			type: 'spoken',
			text: 'For checkout api, main?',
			source: 'kernel',
			ref: 'checkout-api/main',
			isAsking: true,
		});
		const lineId = asked.spoken.at(-1)?.id ?? '';
		convo.store.dispatch({ type: 'spoken_ended', lineId, isCut: false, isUnplayed: true });
		await convo.listen();

		expect(convo.store.state.targetAsk).toBeNull();
		expect(convo.inputs).toContainEqual(
			expect.objectContaining({
				type: 'send',
				ref: 'store-front/main',
				text: 'review all of this',
			}),
		);
	});

	it('"For …?" answered by a click: "No, here" sends the words to the screen, "Send to X" there, once (debug notes 40-41)', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');

		const askWhich = (text: string) => {
			convo.store.dispatch({
				type: 'ask_which',
				ref: 'checkout-api/main',
				screen: 'store-front/main',
				text,
			});

			return convo.store.state.targetAsk?.at ?? -1;
		};

		const sendsOf = (text: string) =>
			convo.inputs.filter((input) => input.type === 'send' && input.text === text);

		const kept = askWhich('check if it was on work two');
		applyPageAction(convo.store, { type: 'settle_target', at: kept, toTarget: false });
		applyPageAction(convo.store, { type: 'settle_target', at: kept, toTarget: false });

		const sent = askWhich('review the checkout changes');
		applyPageAction(convo.store, { type: 'settle_target', at: sent, toTarget: true });
		await convo.listen();

		expect(convo.store.state.targetAsk).toBeNull();
		expect(sendsOf('check if it was on work two')).toEqual([
			expect.objectContaining({ ref: 'store-front/main' }),
		]);
		expect(sendsOf('review the checkout changes')).toEqual([
			expect.objectContaining({ ref: 'checkout-api/main' }),
		]);
	});

	it('an aside asked on its screen, answered after the developer left → held, then heard once on return (debug note 42)', async () => {
		const convo = createConversation({ refs: REFS, view: 'checkout-api/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.store.dispatch({ type: 'turn_started', ref: 'checkout-api/main' });
		const question = 'which file holds the retry backoff?';
		convo.store.dispatch({ type: 'send', ref: 'checkout-api/main', text: question, aside: true });
		const itemId =
			convo.store.state.sessions['checkout-api/main']?.stream.find((item) => item.kind === 'aside')
				?.id ?? '';
		const answer =
			'The backoff lives in the retry module, it doubles from one second up to thirty, and the tests for it sit right beside it.';

		await convo.show('store-front/main');
		convo.store.dispatch({
			type: 'aside_settled',
			ref: 'checkout-api/main',
			itemId,
			question,
			status: 'answered',
			answer: `<spoken>${answer}</spoken>`,
		});
		await convo.wait(15_000);

		expect(convo.heard.filter((line) => line.includes(answer))).toEqual([]);

		await convo.show('checkout-api/main');
		await convo.wait(5_000);

		// Replayed as held lines are, with where the session stands: "… — still working."
		expect(convo.heard).toEqual([`${answer.slice(0, -1)} — still working.`]);
	});

	it('a click on an older "For …?" after a newer one replaced it → nothing sent, the newer one still open', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		const askWhich = (text: string) =>
			convo.store.dispatch({
				type: 'ask_which',
				ref: 'checkout-api/main',
				screen: 'store-front/main',
				text,
			}).targetAsk?.at ?? -1;

		const older = askWhich('first words');
		await convo.wait(1_000);
		const newer = askWhich('second words');
		applyPageAction(convo.store, { type: 'settle_target', at: older, toTarget: true });

		expect(newer).not.toBe(older);
		expect(convo.store.state.targetAsk?.at).toBe(newer);
		expect(convo.inputs.filter((input) => input.type === 'send')).toEqual([]);
	});

	it('"For …?" answered yes → the words go there, with the switch offered; silence keeps them on the screen', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Can you review all of the checkout api changes?');
		await convo.say('Yes.');
		await convo.wait(SWITCH_OFFER_MS + 1_000);

		convo.script([toolUse('t2', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('And the checkout api docs too?');
		await convo.wait(9_000);

		expect(convo.heard).toEqual([
			'> Can you review all of the checkout api changes?',
			'For checkout api, main?',
			'> Yes.',
			'Sent to checkout api, main. Switch there?',
			'> And the checkout api docs too?',
			'For checkout api, main?',
			'Kept on store front, main.',
		]);
	});
	it("Set up's chat working the setup session meanwhile → nothing of it heard, never in meanwhile, never a switch target", async () => {
		const convo = createConversation({ refs: ['setup', ...REFS], view: 'store-front/main' });
		await convo.startSessions('setup', 'store-front/main', 'checkout-api/main');

		// Typed in Set up's chat: the page's own send, with no ack and no spoken words.
		convo.store.dispatch({ type: 'send', ref: 'setup', text: 'add store-api as a project' });
		convo.store.dispatch({ type: 'turn_started', ref: 'setup' });
		convo.store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'ask-setup-1',
				ref: 'setup',
				at: 1,
				kind: 'permission',
				toolName: 'Bash',
				summary: 'run crew add project store-api',
				input: { command: 'crew add project store-api' },
				suggestions: [],
			},
		});
		convo.script([toolUse('t1', 'forward', { kind: 'instruction' })]);
		await convo.say('Run the tests here.');
		await convo.answer('setup', 'Added store-api; its check passed.');
		await convo.answer('store-front/main', 'All 40 tests pass.');
		await convo.wait(30_000);

		expect(convo.heard).toEqual(['> Run the tests here.', 'All 40 tests pass.']);
		expect(convo.store.state.meanwhile).toEqual([]);
		expect(convo.store.state.switchOffer).toBeNull();
		// Its ask waits in Set up's chat, where it is answered; voice neither says nor counts it.
		expect(convo.store.state.asks.map((ask) => ask.ref)).toEqual(['setup']);

		convo.script([toolUse('t2', 'ignore_words', {})]);
		await convo.say('Yes.');

		expect(convo.kernelSaw()).not.toContain('setup');
		expect(convo.store.state.asks.map((ask) => ask.ref)).toEqual(['setup']);
		expect(convo.store.state.view).toEqual({
			kind: 'session',
			ref: 'store-front/main',
			from: 'active',
		});
	});

	it('another session finishes mid-conversation → it waits for the quiet, then comes as one "meanwhile" line', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		const report =
			'The retry backoff now doubles from one second up to thirty, and every retry test passes again.';

		convo.store.dispatch({
			type: 'send',
			ref: 'checkout-api/main',
			text: 'add backoff to the retries',
		});
		convo.script([toolUse('t1', 'forward', { kind: 'instruction' })]);
		await convo.say('Run the tests here.');
		await convo.answer('checkout-api/main', report);
		await convo.answer('store-front/main', 'All 40 tests pass.');
		await convo.wait(3_000);

		expect(convo.heard).toEqual(['> Run the tests here.', 'All 40 tests pass.']);
		expect(convo.store.state.meanwhile.map((item) => item.ref)).toEqual(['checkout-api/main']);

		await convo.wait(6_000);

		expect(convo.heard.at(-1)).toBe(
			'Meanwhile, checkout api, main said: The retry backoff now doubles from one second up to thirty, and every retry test passes again. Switch there?',
		);
		expect(convo.store.state.meanwhile).toEqual([]);
	});

	it('an answer from a session not on screen → it waits for the meanwhile line, never said in full', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
		await convo.say('Checkout api, run the full suite and tell me if it is green.');
		convo.store.dispatch({ type: 'turn_started', ref: 'checkout-api/main' });
		await convo.wait(180_000);

		const answer =
			'212 of 214 pass; the two failures are in the retry jitter tests, both timing out on the slow runner.';
		await convo.answer('checkout-api/main', answer);

		expect(convo.heard).not.toContain(`checkout api, main: ${answer}`);
		await convo.wait(9_000);
		expect(convo.heard.at(-1)).toStartWith('Meanwhile, checkout api, main said: 212 of 214 pass');
		expect(convo.heard.at(-1)).toEndWith('Switch there?');
	});
	it('an update waiting for the quiet, then the developer switches there → heard once, never again in the meanwhile line', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		const report =
			'The retry backoff now doubles from one second up to thirty, and every retry test passes again.';
		convo.store.dispatch({
			type: 'send',
			ref: 'checkout-api/main',
			text: 'add backoff to the retries',
		});
		await convo.answer('checkout-api/main', report);
		expect(convo.store.state.meanwhile.map((item) => item.ref)).toEqual(['checkout-api/main']);

		convo.script([toolUse('t1', 'switch_view', { ref: 'checkout-api/main' })]);
		await convo.say('Switch to checkout.');
		await convo.wait(20_000);

		expect(convo.heard.filter((line) => line.includes('retry backoff now doubles'))).toHaveLength(
			1,
		);
		expect(convo.heard.some((line) => line.startsWith('Meanwhile'))).toBe(false);
	});

	it('words after the meanwhile line → the kernel sees whose line it was, and no rule that routes a reply to it', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.store.dispatch({
			type: 'send',
			ref: 'checkout-api/main',
			text: 'add backoff to the retries',
		});
		await convo.answer(
			'checkout-api/main',
			'The retry backoff now doubles from one second up to thirty, and every retry test passes again.',
		);
		await convo.wait(9_000);
		expect(convo.heard.at(-1)).toStartWith('Meanwhile, checkout api, main said:');

		convo.script([reply('')]);
		await convo.say('Great, push it.');

		// Context for "switch to it" and read-backs; where words go is the screen's or a name's.
		expect(convo.kernelSaw()).toMatch(/checkout-api\/main[^\n]*Meanwhile, checkout api, main said/);
		expect(convo.kernelSaw()).not.toContain('Replying to');
	});

	it('the meanwhile line about one session asks "Switch there?": yes switches there', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		await hearUpdate(convo);

		expect(convo.heard.at(-1)).toBe(`${MEANWHILE_LINE} Switch there?`);
		expect(convo.store.state.switchOffer?.ref).toBe('checkout-api/main');

		convo.script([toolUse('t1', 'switch_view', { ref: 'checkout-api/main' })]);
		await convo.say('Yes.');

		expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: 'checkout-api/main' });
	});

	it('the status of another session, answered by Voice OS → "Switch to X?" after it, and a yes switches (debug note 35)', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');

		convo.script(
			[toolUse('t1', 'read_state', { ref: 'checkout-api/main' })],
			[reply('Checkout api is running the release checklist.')],
		);
		await convo.say('How is the checkout api doing?');

		expect(convo.heard).toEqual([
			'> How is the checkout api doing?',
			'Checkout api is running the release checklist.',
			'Switch to checkout api, main?',
		]);
		expect(convo.store.state.switchOffer?.ref).toBe('checkout-api/main');
	});

	it('the same status question typed on Active → answered, no switch offered: it is read, not heard', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		await convo.show(null);

		convo.script(
			[toolUse('t1', 'read_state', { ref: 'checkout-api/main' })],
			[reply('Checkout api is running the release checklist.')],
		);
		await convo.type('How is the checkout api doing?');

		expect(convo.kernelSaw()).toContain('How is the checkout api doing?');
		expect(convo.store.state.switchOffer).toBeNull();
		expect(convo.heard.some((line) => line.startsWith('Switch to'))).toBe(false);
	});

	it('"switch to checkout, ask it…" → switched, and the rest reaches it (debug note 36)', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');

		convo.script([
			toolUse('t1', 'switch_view', { ref: 'checkout-api/main' }),
			toolUse('t2', 'send_to', {
				ref: 'checkout-api/main',
				kind: 'instruction',
				text: 'ask it to research live voice models for us',
			}),
		]);
		await convo.say('Switch to checkout api and ask it to research live voice models for us.');

		expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: 'checkout-api/main' });
		expect(convo.inputs).toContainEqual(
			expect.objectContaining({
				type: 'send',
				ref: 'checkout-api/main',
				text: 'ask it to research live voice models for us',
			}),
		);
		expect(convo.heard.filter((line) => line.startsWith('For '))).toEqual([]);
	});

	it('"Switch there?" → "Yes." taken for "what did I miss?" again → refused, and the kernel switches (debug note 38)', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		await hearUpdate(convo);

		convo.script([
			toolUse('t1', 'play_missed', {}),
			toolUse('t2', 'switch_view', { ref: 'checkout-api/main' }),
		]);
		await convo.say('Yes.');

		expect(convo.heard).not.toContain('Nothing new.');
		expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: 'checkout-api/main' });
	});

	it('"Switch there?" answered no → closed without the kernel, nothing sent', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		await hearUpdate(convo);
		const sends = convo.inputs.filter((input) => input.type === 'send').length;

		await convo.say('No.');

		expect(convo.store.state.switchOffer).toBeNull();
		expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: 'store-front/main' });
		expect(convo.kernelSaw()).toBe('');
		expect(convo.inputs.filter((input) => input.type === 'send')).toHaveLength(sends);
	});

	it('debug note: "Okay, what\'s the current price?" after the meanwhile line → a question for the screen', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		await convo.answer(
			'checkout-api/main',
			'The pricing table now lists the annual plan at ninety dollars, down from a hundred and twenty.',
		);
		await convo.wait(9_000);
		expect(convo.heard.at(-1)).toEndWith('Switch there?');

		// The model reaches for the session whose line was just heard: the name was never said.
		convo.script(
			[toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })],
			[toolUse('t2', 'forward', { kind: 'question' })],
		);
		await convo.say("Okay, what's the current price?");

		expect(convo.inputs).toContainEqual(
			expect.objectContaining({
				type: 'send',
				ref: 'store-front/main',
				text: "Okay, what's the current price?",
			}),
		);
		expect(convo.inputs).not.toContainEqual(
			expect.objectContaining({ type: 'send', ref: 'checkout-api/main' }),
		);
		expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: 'store-front/main' });
	});
	it('an update waiting but not yet heard, then words named and spoken to that session → sent there, its update settled', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.store.dispatch({
			type: 'send',
			ref: 'checkout-api/main',
			text: 'add backoff to the retries',
		});
		await convo.answer(
			'checkout-api/main',
			'The retry backoff now doubles, and every retry test passes again.',
		);

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
		await convo.say('Checkout api, is the build green?');

		expect(convo.heard.at(-1)).toBe('Sent to checkout api, main. Switch there?');

		// Spoken to, its waiting update is settled: no meanwhile line repeats it later.
		await convo.wait(20_000);
		expect(convo.heard.some((line) => line.startsWith('Meanwhile'))).toBe(false);
	});
	it('words named to a session at work → one line: when it goes, and the offer', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.store.dispatch({ type: 'turn_started', ref: 'checkout-api/main' });
		const heardBefore = convo.heard.length;

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Tell checkout api to push it.');

		const said = convo.heard.slice(heardBefore + 1);
		expect(said).toHaveLength(1);
		expect(said[0]).toEndWith('Switch there?');
		expect(said[0]).not.toStartWith('Sent to');
	});
	it('a meanwhile line naming two sessions → names only, no question; words naming neither stay on the screen', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main', 'signals/main');
		await convo.answer('checkout-api/main', UPDATE);
		await convo.answer(
			'signals/main',
			'The ingest queue drains in under a minute now, and the dashboard shows it live.',
		);
		await convo.wait(9_000);
		expect(convo.heard.at(-1)).toContain('signals, main said:');
		expect(convo.heard.at(-1)).not.toContain('Switch there?');
		expect(convo.store.state.switchOffer).toBeNull();

		convo.script(
			[toolUse('t1', 'send_to', { ref: 'signals/main', kind: 'instruction' })],
			[toolUse('t2', 'forward', { kind: 'instruction' })],
		);
		await convo.say('Nice, ship it.');

		expect(convo.inputs).toContainEqual(
			expect.objectContaining({ type: 'send', ref: 'store-front/main', text: 'Nice, ship it.' }),
		);
		expect(convo.inputs).not.toContainEqual(
			expect.objectContaining({ type: 'send', ref: 'signals/main', text: 'Nice, ship it.' }),
		);
	});
	it('its permission answered → its waiting update is settled; a typed message to it leaves it waiting', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.store.dispatch({
			type: 'meanwhile_added',
			ref: 'checkout-api/main',
			kind: 'done',
			about: 'x y',
		});
		convo.store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'p1',
				ref: 'checkout-api/main',
				at: 0,
				kind: 'permission',
				toolName: 'Bash',
				summary: 'run git push',
				input: {},
				suggestions: [],
			},
		});
		convo.store.dispatch({ type: 'answer_permission', askId: 'p1', decision: 'allow' });
		expect(convo.store.state.meanwhile).toEqual([]);

		convo.store.dispatch({
			type: 'meanwhile_added',
			ref: 'checkout-api/main',
			kind: 'done',
			about: 'x y',
		});
		convo.store.dispatch({ type: 'send', ref: 'checkout-api/main', text: 'typed words' });
		expect(convo.store.state.meanwhile.map((item) => item.ref)).toEqual(['checkout-api/main']);
	});

	describe("another session's question, plan or permission, in the meanwhile line", () => {
		const CHECKOUT = 'checkout-api/main';
		const permission = (id = 'p1'): PendingAsk => ({
			id,
			ref: CHECKOUT,
			at: 1,
			kind: 'permission',
			toolName: 'Bash',
			summary: 'run git push origin main',
			input: { command: 'git push origin main' },
			suggestions: [],
		});
		const question = (text: string, id = 'q1'): PendingAsk => ({
			id,
			ref: CHECKOUT,
			at: 1,
			kind: 'question',
			input: {},
			questions: [{ question: text, multiSelect: false, options: [] }],
		});
		const plan: PendingAsk = {
			id: 'pl1',
			ref: CHECKOUT,
			at: 1,
			kind: 'plan',
			input: {},
			plan: '# Retry backoff with jitter\n\n1. Cap at thirty seconds.',
		};

		const onStoreFront = async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', CHECKOUT);

			return convo;
		};

		it('a permission → after a breath, said in full; a yes allows it without switching', async () => {
			const convo = await onStoreFront();
			convo.store.dispatch({ type: 'ask_opened', ask: permission() });
			await convo.wait(3_100);

			expect(convo.heard.at(-1)).toBe('Meanwhile, checkout api, main wants to run git push.');

			convo.script([toolUse('t1', 'answer', { ref: CHECKOUT, decision: 'yes', text: '' })]);
			await convo.say('Yes.');

			expect(convo.store.state.asks).toEqual([]);
			expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: 'store-front/main' });
		});

		it('a short question → said in full; an answer lands on it without switching', async () => {
			const convo = await onStoreFront();
			convo.store.dispatch({ type: 'ask_opened', ask: question('Postgres or SQLite?') });
			await convo.wait(3_100);

			expect(convo.heard.at(-1)).toBe('Meanwhile, checkout api, main asks: Postgres or SQLite?');

			convo.script([
				toolUse('t1', 'answer', { ref: CHECKOUT, decision: 'choose', text: 'Postgres' }),
			]);
			await convo.say('Postgres.');

			expect(convo.store.state.asks).toEqual([]);
			expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: 'store-front/main' });
		});

		it('a plan → its title only, and "Switch there?"; a bare yes plays the plan there, unapproved', async () => {
			const convo = await onStoreFront();
			convo.store.dispatch({ type: 'ask_opened', ask: plan });
			await convo.wait(3_100);

			expect(convo.heard.at(-1)).toBe(
				'Meanwhile, checkout api, main has a plan ready: Retry backoff with jitter. Switch there?',
			);

			// The model reaches for the plan: a yes to the offer only opens it.
			convo.script([toolUse('t1', 'answer', { ref: CHECKOUT, decision: 'yes', text: '' })]);
			await convo.say('Yes.');

			expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: CHECKOUT });
			expect(convo.heard.at(-1)).toBe('checkout-api/main has a plan ready for approval.');
			expect(convo.store.state.asks.map((ask) => ask.id)).toEqual(['pl1']);
		});
		it('"switch to it" right after the line → switched once, announced, no second question', async () => {
			const convo = await onStoreFront();
			convo.store.dispatch({ type: 'ask_opened', ask: plan });
			await convo.wait(3_100);

			convo.script([toolUse('t1', 'switch_view', { ref: CHECKOUT })]);
			await convo.say('Switch to it.');

			expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: CHECKOUT });
			expect(convo.heard.some((line) => line.endsWith('?') && line.startsWith('Switch to'))).toBe(
				false,
			);
		});

		it('two asks said in full in one line → the kernel is told a bare yes is for neither', async () => {
			const convo = await onStoreFront();
			await convo.startSessions('signals/main');
			convo.store.dispatch({ type: 'ask_opened', ask: permission() });
			convo.store.dispatch({
				type: 'ask_opened',
				ask: { ...question('Ship tonight?', 'q2'), ref: 'signals/main' },
			});
			await convo.wait(3_100);

			expect(convo.heard.at(-1)).toBe(
				'Meanwhile, checkout api, main wants to run git push, and signals, main asks: Ship tonight?',
			);

			convo.script([reply('For which one?')]);
			await convo.say('Yes.');

			expect(convo.kernelSaw()).toContain('ask which');
			expect(convo.store.state.asks.map((ask) => ask.id)).toEqual(['p1', 'q2']);
		});

		it('three asks → the line tells two by name and counts the third, which stays only announced', async () => {
			const convo = createConversation({ refs: [...REFS, 'admin/main'], view: 'store-front/main' });
			await convo.startSessions('store-front/main', CHECKOUT, 'signals/main', 'admin/main');
			convo.store.dispatch({ type: 'ask_opened', ask: permission() });
			convo.store.dispatch({
				type: 'ask_opened',
				ask: { ...question('Ship tonight?', 'q2'), ref: 'signals/main' },
			});
			convo.store.dispatch({
				type: 'ask_opened',
				ask: { ...question('Keep the old admin?', 'q3'), ref: 'admin/main' },
			});
			await convo.wait(3_100);

			expect(convo.heard.at(-1)).toEndWith('and one other needs you.');
			expect(convo.store.state.sessions['admin/main']?.heldLine).toMatchObject({
				kind: 'ask',
				askId: 'q3',
			});
			expect(convo.store.state.sessions[CHECKOUT]?.heldLine).toBeNull();
		});

		it('a newer ask from the same session before the breath → one line, with the newer words', async () => {
			const convo = await onStoreFront();
			convo.store.dispatch({ type: 'ask_opened', ask: question('Postgres or SQLite?') });
			convo.store.dispatch({ type: 'ask_closed', askId: 'q1' });
			convo.store.dispatch({ type: 'ask_opened', ask: permission('p2') });
			await convo.wait(3_100);

			const lines = convo.heard.filter((line) => line.startsWith('Meanwhile'));
			expect(lines).toEqual(['Meanwhile, checkout api, main wants to run git push.']);
		});

		it('"switch to it" long after the line → no longer about it: not switched, the kernel says what waits', async () => {
			const convo = await onStoreFront();
			convo.store.dispatch({ type: 'ask_opened', ask: plan });
			await convo.wait(3_100);
			await convo.wait(120_000);

			convo.script([toolUse('t1', 'switch_view', { ref: CHECKOUT })]);
			await convo.say('Switch to it.');

			expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: 'store-front/main' });
		});

		it('answered on the page before the breath → never said', async () => {
			const convo = await onStoreFront();
			convo.store.dispatch({ type: 'ask_opened', ask: permission() });
			convo.store.dispatch({ type: 'answer_permission', askId: 'p1', decision: 'allow' });
			await convo.wait(20_000);

			expect(convo.heard.some((line) => line.startsWith('Meanwhile'))).toBe(false);
		});

		it('words sent to checkout, then its question → saved for the meanwhile line, not asked over the screen', async () => {
			const convo = await onStoreFront();
			convo.script([toolUse('t1', 'send_to', { ref: CHECKOUT, kind: 'question' })]);
			await convo.say('Checkout api, which database?');
			convo.store.dispatch({ type: 'ask_opened', ask: question('Postgres or SQLite?') });
			await convo.wait(3_100);

			expect(convo.heard.at(-1)).toBe('Meanwhile, checkout api, main asks: Postgres or SQLite?');
			expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: 'store-front/main' });
		});
	});

	describe('told about a session by the kernel, then words for it', () => {
		const READ_BACK = 'Checkout api finished the retries and asks whether to push.';

		// Checkout's update is held, not yet said: the developer hears of it from the kernel instead.
		const withUpdateWaiting = async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.store.dispatch({
				type: 'send',
				ref: 'checkout-api/main',
				text: 'add backoff to the retries',
			});
			await convo.answer('checkout-api/main', UPDATE);

			return convo;
		};

		const replyToCheckout = async (convo: ReturnType<typeof createConversation>) => {
			convo.script([toolUse('t9', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
			await convo.say('Tell checkout api to push.');
		};

		it('"where\'s the status?" read back → no meanwhile line repeats it; the switch is offered after it, and again with words sent there', async () => {
			const convo = await withUpdateWaiting();
			convo.script([toolUse('t1', 'read_state', { ref: 'checkout-api/main' })], [reply(READ_BACK)]);
			await convo.say("Where's the status?");
			expect(convo.store.state.meanwhile).toEqual([]);
			await replyToCheckout(convo);

			expect(convo.heard.slice(-4)).toEqual([
				READ_BACK,
				'Switch to checkout api, main?',
				'> Tell checkout api to push.',
				'Sent to checkout api, main. Switch there?',
			]);

			await convo.wait(60_000);
			expect(convo.heard.some((line) => line.startsWith('Meanwhile'))).toBe(false);
		});

		it('a reply after the read-back that names no session → refused there, forwarded to the screen', async () => {
			const convo = await withUpdateWaiting();
			convo.script([toolUse('t1', 'read_state', { ref: 'checkout-api/main' })], [reply(READ_BACK)]);
			await convo.say("Where's the status?");
			convo.script(
				[toolUse('t2', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })],
				[toolUse('t3', 'forward', { kind: 'instruction' })],
			);
			await convo.say('Tell it to push.');

			expect(convo.inputs).toContainEqual(
				expect.objectContaining({
					type: 'send',
					ref: 'store-front/main',
					text: 'Tell it to push.',
				}),
			);
			expect(convo.inputs).not.toContainEqual(
				expect.objectContaining({
					type: 'send',
					ref: 'checkout-api/main',
					text: 'Tell it to push.',
				}),
			);
		});
		it("another session's permission open, then the offer → a bare yes switches and approves nothing", async () => {
			const convo = await withUpdateWaiting();
			convo.store.dispatch({
				type: 'ask_opened',
				ask: {
					id: 'p1',
					ref: 'signals/main',
					at: 0,
					kind: 'permission',
					toolName: 'Bash',
					summary: 'run git push',
					input: {},
					suggestions: [],
				},
			});
			await convo.listen();
			convo.script([toolUse('t1', 'read_state', { ref: 'checkout-api/main' })], [reply(READ_BACK)]);
			await convo.say("Where's the status?");
			await replyToCheckout(convo);
			expect(convo.heard.at(-1)).toBe('Sent to checkout api, main. Switch there?');

			// The model reaches for the permission: the guard sends it to the offer instead.
			convo.script(
				[toolUse('t2', 'answer', { ref: 'signals/main', decision: 'yes', text: '' })],
				[toolUse('t3', 'switch_view', { ref: 'checkout-api/main' })],
			);
			await convo.say('Yes.');

			expect(convo.store.state.asks.map((ask) => ask.id)).toEqual(['p1']);
			expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: 'checkout-api/main' });
		});
	});

	it('"status update" → a recap of what waits, said now; the meanwhile line never repeats it', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.store.dispatch({
			type: 'meanwhile_added',
			ref: 'checkout-api/main',
			kind: 'done',
			about: 'all retry tests pass',
		});

		convo.script([toolUse('t1', 'status_update', { ref: null, minutes: null })]);
		await convo.say('Give me a status update.');

		expect(convo.heard).toEqual([
			'> Give me a status update.',
			'checkout api, main: all retry tests pass.',
		]);
		expect(convo.store.state.meanwhile).toEqual([]);

		await convo.wait(60_000);
		expect(convo.heard.some((line) => line.startsWith('Meanwhile'))).toBe(false);
	});

	it('"what did I miss?" → the waiting updates now, without waiting for the quiet', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.store.dispatch({
			type: 'meanwhile_added',
			ref: 'checkout-api/main',
			kind: 'done',
			about: 'all retry tests pass',
		});

		convo.script([toolUse('t1', 'play_missed', {})]);
		await convo.say('What did I miss?');

		expect(convo.heard).toEqual([
			'> What did I miss?',
			'Meanwhile, checkout api, main said: all retry tests pass. Switch there?',
		]);
	});

	it('a permission from another session mid-answer (design 5) → after that answer and a breath, never over it', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.store.dispatch({ type: 'send', ref: 'checkout-api/main', text: 'push the fix' });

		convo.script([toolUse('t1', 'forward', { kind: 'question' })]);
		await convo.say('Do deep links go through the same handler?');
		convo.voiceOut.say({
			text: 'Deep links go through a separate handler.',
			priority: 'high',
			ref: 'store-front/main',
			isAnswer: true,
		});
		convo.store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'p1',
				ref: 'checkout-api/main',
				at: 1,
				kind: 'permission',
				toolName: 'Bash',
				summary: 'run git push origin main',
				input: { command: 'git push origin main' },
				suggestions: [],
			},
		});
		await convo.listen();

		expect(convo.heard).toEqual([
			'> Do deep links go through the same handler?',
			'Deep links go through a separate handler.',
		]);

		await convo.wait(3_100);

		// On another session's screen the ask comes in the meanwhile line after a breath, said in full:
		// what the call does, never the whole command.
		expect(convo.heard.at(-1)).toBe('Meanwhile, checkout api, main wants to run git push.');
	});

	// "Can you approve?" is a yes to the plan on screen, not a question about it.
	it('the screen\'s plan waits, "Okay, can you approve?" → the plan is approved', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main');
		convo.store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'pl1',
				ref: 'store-front/main',
				at: 1,
				kind: 'plan',
				input: {},
				plan: '# Cart totals in cents\n\n1. Store prices as integers.',
			},
		});

		convo.script([toolUse('t1', 'answer', { ref: 'store-front/main', decision: 'yes', text: '' })]);
		await convo.say('Okay, can you approve?');

		expect(convo.inputs).toContainEqual(
			expect.objectContaining({ type: 'answer_plan', askId: 'pl1', isApproved: true }),
		);
		expect(convo.store.state.asks).toEqual([]);
	});

	describe('words go to the screen, or to a session named in them', () => {
		const ADMIN = 'admin/main';
		const SIGNALS = 'signals/main';

		// Admin Main is the developer's own name for admin/main; they were on signals/main, then went back.
		const backOnAdminMain = async () => {
			const convo = createConversation({ refs: [ADMIN, SIGNALS], view: ADMIN });
			await convo.startSessions(ADMIN, SIGNALS);
			convo.store.dispatch({ type: 'rename_session', ref: ADMIN, name: 'Admin Main' });
			await convo.show(SIGNALS);
			convo.store.dispatch({ type: 'go_back' });
			await convo.listen();

			return convo;
		};

		const sendsOf = (convo: ReturnType<typeof createConversation>) =>
			convo.inputs.flatMap((input) => (input.type === 'send' ? [[input.ref, input.text]] : []));

		// Debug notes: each of these went to signals/main, the session the developer had just left or heard.
		for (const said of [
			'Make sure you will do this on top of the modes branch.',
			'Can you make sure that all the branches will be named the same?',
			"There's another debug note. Can you also please fix that?",
		]) {
			it(`debug note: "${said}" → no session named: for the screen`, async () => {
				const convo = await backOnAdminMain();
				expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: ADMIN });

				convo.script(
					[toolUse('t1', 'send_to', { ref: SIGNALS, kind: 'instruction' })],
					[toolUse('t2', 'forward', { kind: 'instruction' })],
				);
				await convo.say(said);

				expect(sendsOf(convo)).toEqual([[ADMIN, said]]);
				expect(convo.heard.at(-1)).toBe(`> ${said}`);
			});
		}

		it('debug note: a reply to the screen\'s own question that mentions another session → "For …?"; no keeps it on the screen', async () => {
			const convo = await backOnAdminMain();
			await convo.show(SIGNALS);
			convo.store.dispatch({
				type: 'narration',
				ref: SIGNALS,
				needsUser: true,
				text: 'Should I name the branches the way Admin Main does?',
			});
			await convo.listen();
			const said = 'Yes, name them the same as in Admin Main.';

			convo.script([toolUse('t1', 'send_to', { ref: ADMIN, kind: 'instruction' })]);
			await convo.say(said);
			await convo.say('No.');

			expect(convo.heard.slice(-4)).toEqual([
				`> ${said}`,
				'For Admin Main?',
				'> No.',
				'Kept on signals, main.',
			]);
			expect(sendsOf(convo)).toEqual([[SIGNALS, said]]);
		});

		it('the display name said and spoken to → sent there, the switch offered', async () => {
			const convo = await backOnAdminMain();
			await convo.show(SIGNALS);

			convo.script([toolUse('t1', 'send_to', { ref: ADMIN, kind: 'instruction' })]);
			await convo.say('Admin Main, rebase on the modes branch.');

			expect(sendsOf(convo)).toEqual([[ADMIN, 'Admin Main, rebase on the modes branch.']]);
			expect(convo.heard.at(-1)).toBe('Sent to Admin Main. Switch there?');
		});

		it('"Sorry, I meant that for …" → the earlier words go to the session named, without asking', async () => {
			const convo = await backOnAdminMain();
			convo.script([toolUse('t1', 'forward', { kind: 'instruction' })]);
			await convo.say('Run the release checklist.');

			convo.script([
				toolUse('t2', 'send_to', {
					ref: SIGNALS,
					kind: 'instruction',
					text: 'Run the release checklist.',
				}),
			]);
			await convo.say('Sorry, I meant that for signals main.');

			expect(sendsOf(convo)).toEqual([
				[ADMIN, 'Run the release checklist.'],
				[SIGNALS, 'Run the release checklist.'],
			]);
			expect(convo.store.state.targetAsk).toBeNull();
		});
	});

	describe('timing', () => {
		// Checkout's update heard in the meanwhile line and its own offer let go, then words named and
		// spoken to checkout: "Sent to …. Switch there?".
		// beforeReply: what happens after the update is heard, before the words that make the offer.
		const offerAfterHeardUpdate = async ({
			beforeReply,
			judge,
		}: {
			beforeReply?: (convo: ReturnType<typeof createConversation>) => Promise<void>;
			judge?: Judge;
		} = {}) => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main', judge });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.store.dispatch({
				type: 'send',
				ref: 'checkout-api/main',
				text: 'add backoff to the retries',
			});
			await convo.answer(
				'checkout-api/main',
				'The retry backoff now doubles from one second up to thirty, and every retry test passes again.',
			);
			await convo.wait(9_000 + SWITCH_OFFER_MS + 1_000);
			await beforeReply?.(convo);
			convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
			await convo.say('Checkout api, push it.');

			return convo;
		};

		it('"Switch to …?" unanswered → let go after 8 s', async () => {
			const convo = await offerAfterHeardUpdate();
			expect(convo.store.state.switchOffer?.ref).toBe('checkout-api/main');

			await convo.wait(SWITCH_OFFER_MS + 1);

			expect(convo.store.state.switchOffer).toBeNull();
		});

		it('"Switch to …?" answered yes → switched there, and said', async () => {
			const convo = await offerAfterHeardUpdate();

			convo.script([toolUse('t2', 'switch_view', { ref: 'checkout-api/main' })]);
			await convo.say('Yes.');

			expect(convo.store.state.view).toEqual({
				kind: 'session',
				ref: 'checkout-api/main',
				from: 'active',
			});
			expect(convo.heard.slice(-2)).toEqual(['> Yes.', 'Switching to checkout api, main.']);
		});

		// Debug note 13: a "no" to the offer reached the kernel, which asked "For …?" about it.
		it('"Switch to …?" answered no → let go then and there: the kernel never reads it, nothing is sent', async () => {
			const convo = await offerAfterHeardUpdate();
			const sendsBefore = convo.inputs.filter((input) => input.type === 'send').length;
			const kernelBefore = convo.kernelSaw();

			await convo.say('No.');

			expect(convo.kernelSaw()).toBe(kernelBefore);

			expect(convo.store.state.switchOffer).toBeNull();
			expect(convo.store.state.targetAsk).toBeNull();
			expect(convo.inputs.filter((input) => input.type === 'send')).toHaveLength(sendsBefore);
			expect(convo.inputs.some((input) => input.type === 'ask_which')).toBe(false);
			expect(convo.heard.at(-1)).toBe('> No.');
			expect(convo.store.state.voiceLog['store-front/main']?.at(-1)).toMatchObject({
				utterance: 'No.',
				did: ['switch offer declined'],
			});
		});

		const permissionFrom = (ref: string, at: number): PendingAsk => ({
			id: 'p1',
			ref,
			at,
			kind: 'permission',
			toolName: 'Bash',
			summary: 'run git push',
			input: {},
			suggestions: [],
		});

		it('"Switch to …?", then the screen\'s session asks a permission → a bare no answers the permission, through the kernel; the offer is let go', async () => {
			const convo = await offerAfterHeardUpdate();
			const offerAt = convo.store.state.switchOffer?.at ?? 0;
			convo.store.dispatch({
				type: 'ask_opened',
				ask: permissionFrom('store-front/main', offerAt + 1),
			});
			await convo.listen();
			const kernelBefore = convo.kernelSaw();

			convo.script([
				toolUse('t2', 'answer', { ref: 'store-front/main', decision: 'no', text: '' }),
			]);
			await convo.say('No.');

			expect(convo.kernelSaw()).not.toBe(kernelBefore);
			expect(convo.store.state.asks).toEqual([]);
			expect(convo.inputs).toContainEqual(
				expect.objectContaining({ type: 'answer_permission', askId: 'p1', decision: 'deny' }),
			);
			expect(convo.store.state.switchOffer).toBeNull();
		});

		it('"Switch to …?", then the screen\'s session ends its turn on a question → a bare no is its answer: the kernel reads it', async () => {
			const convo = await offerAfterHeardUpdate();
			await convo.wait(1_000);
			convo.store.dispatch({
				type: 'narration',
				ref: 'store-front/main',
				needsUser: true,
				text: 'Should I push it to main?',
			});
			await convo.listen();
			const kernelBefore = convo.kernelSaw();

			convo.script([toolUse('t2', 'forward', { kind: 'instruction' })]);
			await convo.say('No.');

			expect(convo.kernelSaw()).not.toBe(kernelBefore);
			expect(convo.store.state.voiceLog['store-front/main']?.at(-1)?.utterance).toBe('No.');
			expect(convo.store.state.voiceLog['store-front/main']?.at(-1)?.did).not.toContain(
				'switch offer declined',
			);
			expect(convo.inputs).toContainEqual(
				expect.objectContaining({ type: 'send', ref: 'store-front/main', text: 'No.' }),
			);
		});

		it('"Switch to …?", then "No." typed into the screen\'s box → typed to that session; the offer is not declined by it', async () => {
			const convo = await offerAfterHeardUpdate();
			const kernelBefore = convo.kernelSaw();

			await convo.type('No.');

			expect(convo.kernelSaw()).toBe(kernelBefore);
			expect(convo.inputs).toContainEqual(
				expect.objectContaining({ type: 'send', ref: 'store-front/main', text: 'No.' }),
			);
			expect(convo.store.state.switchOffer?.ref).toBe('checkout-api/main');
			expect(
				(convo.store.state.voiceLog['store-front/main'] ?? []).flatMap((entry) => entry.did),
			).not.toContain('switch offer declined');
		});

		it('another session\'s permission open before "Switch to …?" → a bare no answers the offer alone: closed, the permission untouched, no kernel', async () => {
			const convo = await offerAfterHeardUpdate({
				beforeReply: async (opened) => {
					await opened.startSessions('signals/main');
					opened.store.dispatch({ type: 'ask_opened', ask: permissionFrom('signals/main', 0) });
					await opened.listen();
				},
			});
			expect(convo.store.state.switchOffer?.ref).toBe('checkout-api/main');
			const kernelBefore = convo.kernelSaw();

			await convo.say('No.');

			expect(convo.kernelSaw()).toBe(kernelBefore);
			expect(convo.store.state.switchOffer).toBeNull();
			expect(convo.store.state.asks.map((ask) => ask.id)).toEqual(['p1']);
		});

		it('"Switch to …?" kept past its 8 s while the developer speaks → a yes begun in time still reaches the kernel as the offer\'s answer', async () => {
			const convo = await offerAfterHeardUpdate();
			convo.store.dispatch({
				type: 'transcript',
				transcript: { text: 'Yes', isFinal: false, target: 'store-front/main' },
			});
			await convo.wait(SWITCH_OFFER_MS + 1_000);
			expect(convo.store.state.switchOffer?.ref).toBe('checkout-api/main');

			convo.store.dispatch({ type: 'transcript', transcript: null });
			convo.script([toolUse('t2', 'switch_view', { ref: 'checkout-api/main' })]);
			await convo.say('Yes.', { startedAgoMs: 3_000 });

			expect(convo.kernelSaw()).toContain('switch_offer');
			expect(convo.store.state.view).toEqual({
				kind: 'session',
				ref: 'checkout-api/main',
				from: 'active',
			});
		});

		it('a "no" begun before "Switch to …?" was asked → not its answer: the kernel reads it, the offer stays', async () => {
			const convo = await offerAfterHeardUpdate();
			const kernelBefore = convo.kernelSaw();

			convo.script([toolUse('t2', 'ignore_words', {})]);
			await convo.say('No.', { startedAgoMs: 5_000 });

			expect(convo.kernelSaw()).not.toBe(kernelBefore);
			expect(convo.store.state.switchOffer?.ref).toBe('checkout-api/main');
		});

		it('"Switch to …?" answered with a no and more → new words: the kernel routes them, here they go to the screen', async () => {
			const convo = await offerAfterHeardUpdate();

			convo.script([toolUse('t2', 'forward', { kind: 'instruction' })]);
			await convo.say('No, run the tests here instead.');

			expect(convo.inputs).toContainEqual(
				expect.objectContaining({
					type: 'send',
					ref: 'store-front/main',
					text: 'No, run the tests here instead.',
				}),
			);
			expect(convo.store.state.view).toEqual({
				kind: 'session',
				ref: 'store-front/main',
				from: 'active',
			});
			// Answered by the kernel's turn: the router lets the offer go once it is done.
			expect(convo.store.state.switchOffer).toBeNull();
		});

		// Debug note 13: "For …?" lapsed while the developer was still saying "no", so the held words
		// went to the screen and the "no" itself reached the kernel, which asked again.
		it('"For …?" still being answered when its 8 s run out → waits for the words; the no keeps them on the screen, once', async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
			await convo.say('Review all of the checkout api changes.');

			// They start speaking before the wait ends; the words are routed after it.
			convo.store.dispatch({
				type: 'transcript',
				transcript: { text: 'No', isFinal: false, target: 'store-front/main' },
			});
			await convo.wait(TARGET_ASK_MS + 1_000);
			expect(convo.store.state.targetAsk?.ref).toBe('checkout-api/main');

			convo.store.dispatch({ type: 'transcript', transcript: null });
			const kernelBefore = convo.kernelSaw();
			await convo.say('No.', { startedAgoMs: 3_000 });
			expect(convo.kernelSaw()).toBe(kernelBefore);
			await convo.wait(TARGET_ASK_MS + 1_000);

			const sends = convo.inputs.flatMap((input) =>
				input.type === 'send' ? [[input.ref, input.text]] : [],
			);

			expect(sends).toEqual([['store-front/main', 'Review all of the checkout api changes.']]);
			expect(convo.store.state.targetAsk).toBeNull();
			expect(convo.inputs.filter((input) => input.type === 'ask_which')).toHaveLength(1);
		});

		const askedForCheckout = async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
			await convo.say('Review all of the checkout api changes.');
			expect(convo.store.state.targetAsk?.ref).toBe('checkout-api/main');
			convo.store.dispatch({
				type: 'transcript',
				transcript: { text: 'Um', isFinal: false, target: 'store-front/main' },
			});

			return convo;
		};

		const sendsOf = (convo: ReturnType<typeof createConversation>) =>
			convo.inputs.flatMap((input) => (input.type === 'send' ? [[input.ref, input.text]] : []));

		it('"For …?" with a press that never ends → let go 30 s after its 8 s; the words stay on the screen', async () => {
			const convo = await askedForCheckout();

			await convo.wait(TARGET_ASK_MS + 29_000);
			expect(convo.store.state.targetAsk?.ref).toBe('checkout-api/main');

			await convo.wait(1_500);

			expect(convo.store.state.targetAsk).toBeNull();
			expect(sendsOf(convo)).toEqual([
				['store-front/main', 'Review all of the checkout api changes.'],
			]);
		});

		it('"For …?" waiting on words that end with nothing routed → let go within half a second of the quiet', async () => {
			const convo = await askedForCheckout();
			await convo.wait(TARGET_ASK_MS + 2_000);
			expect(convo.store.state.targetAsk?.ref).toBe('checkout-api/main');

			convo.store.dispatch({ type: 'transcript', transcript: null });
			await convo.wait(500);

			expect(convo.store.state.targetAsk).toBeNull();
			expect(sendsOf(convo)).toEqual([
				['store-front/main', 'Review all of the checkout api changes.'],
			]);
		});

		it('"For …?" answered yes, the words still being read when its 8 s run out → it waits for them; the yes sends the held words there', async () => {
			const held = createHeldJudge('target_answer');
			const convo = createConversation({ refs: REFS, view: 'store-front/main', judge: held.judge });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
			await convo.say('Review all of the checkout api changes.');

			held.arm();
			const said = convo.say('Yes.');
			await convo.wait(TARGET_ASK_MS + 1_000);

			expect(convo.store.state.targetAsk?.ref).toBe('checkout-api/main');
			expect(sendsOf(convo)).toEqual([]);

			held.release();
			await said;

			expect(sendsOf(convo)).toEqual([
				['checkout-api/main', 'Review all of the checkout api changes.'],
			]);
			expect(convo.store.state.targetAsk).toBeNull();
		});

		it('"Switch to …?" answered no, the words still being read when its 8 s run out → it waits for them; the no closes it', async () => {
			const held = createHeldJudge('refuses');
			const convo = await offerAfterHeardUpdate({ judge: held.judge });
			const offer = convo.store.state.switchOffer;
			expect(offer?.ref).toBe('checkout-api/main');

			held.arm();
			const said = convo.say('No.');
			await convo.wait(SWITCH_OFFER_MS + 1_000);

			expect(convo.store.state.switchOffer).toEqual(offer);

			held.release();
			await said;

			expect(convo.store.state.switchOffer).toBeNull();
			expect(convo.store.state.voiceLog['store-front/main']?.at(-1)).toMatchObject({
				did: ['switch offer declined'],
			});
		});

		it('"For …?" answered with new words → the held ones stay on the screen, the new ones are routed', async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
			await convo.say('Review all of the checkout api changes.');
			convo.script([toolUse('t2', 'forward', { kind: 'instruction' })]);
			await convo.say('Actually, run the linter on the whole repo first.');

			const sends = convo.inputs.flatMap((input) =>
				input.type === 'send' ? [[input.ref, input.text]] : [],
			);

			expect(sends).toEqual([
				['store-front/main', 'Review all of the checkout api changes.'],
				['store-front/main', 'Actually, run the linter on the whole repo first.'],
			]);
		});

		it('"For …?" answered "no" with more after it → the held words stay on the screen, and the rest is routed too', async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
			await convo.say('Review all of the checkout api changes.');
			convo.script([toolUse('t2', 'forward', { kind: 'instruction' })]);
			await convo.say('No, and run the linter on the whole repo first.');

			const sends = convo.inputs.flatMap((input) =>
				input.type === 'send' ? [[input.ref, input.text]] : [],
			);

			expect(sends).toEqual([
				['store-front/main', 'Review all of the checkout api changes.'],
				['store-front/main', 'No, and run the linter on the whole repo first.'],
			]);
		});

		it('"For …?" answered yes with more after it → the held words go there, and the rest is routed too', async () => {
			// A long yes in another language: the English patterns would call it something else.
			const judge: Judge = async (params) =>
				params.key === 'target_answer' ? ('yes' as never) : englishJudge(params);
			const convo = createConversation({ refs: REFS, view: 'store-front/main', judge });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
			await convo.say('Review all of the checkout api changes.');
			convo.script([toolUse('t2', 'forward', { kind: 'instruction' })]);
			await convo.say('Ja, und danach führ den Linter aus.');

			const sends = convo.inputs.flatMap((input) =>
				input.type === 'send' ? [[input.ref, input.text]] : [],
			);

			expect(sends).toEqual([
				['checkout-api/main', 'Review all of the checkout api changes.'],
				['store-front/main', 'Ja, und danach führ den Linter aus.'],
			]);
		});

		it('listening: the meanwhile line waits 12 s of quiet, not 8', async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main', isListening: true });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.store.dispatch({
				type: 'meanwhile_added',
				ref: 'checkout-api/main',
				kind: 'done',
				about: 'all retry tests pass',
			});

			await convo.wait(9_000);
			expect(convo.heard).toEqual([]);

			await convo.wait(3_100);
			expect(convo.heard).toEqual([
				'Meanwhile, checkout api, main said: all retry tests pass. Switch there?',
			]);
		});

		it('never quiet for long → the update still comes at the first gap after 50 s', async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.store.dispatch({
				type: 'meanwhile_added',
				ref: 'checkout-api/main',
				kind: 'done',
				about: 'all retry tests pass',
			});

			for (let second = 0; second < 55; second += 5) {
				convo.voiceOut.say({
					text: `line at ${second}`,
					priority: 'normal',
					ref: 'store-front/main',
				});
				await convo.listen();
				await convo.wait(5_000);
			}

			const meanwhileAt = convo.heard.indexOf(
				'Meanwhile, checkout api, main said: all retry tests pass. Switch there?',
			);

			// Never 8 s of quiet, but at 50 s the gap after "line at 45" is the one.
			expect(convo.heard.slice(meanwhileAt - 1, meanwhileAt + 2)).toEqual([
				'line at 45',
				'Meanwhile, checkout api, main said: all retry tests pass. Switch there?',
				'line at 50',
			]);
		});
	});

	describe('active sessions', () => {
		const PERSONAL = { id: 'vm1', host: 'dev@personal.example.com', name: 'Personal' };

		it('"activate the scheduler workspace on Personal" → "Activated … Switch there?"; yes switches there', async () => {
			const convo = createConversation({
				refs: [...REFS, 'vm1:scheduler/main'],
				view: 'store-front/main',
				machines: [PERSONAL],
				inactive: ['vm1:scheduler/main'],
			});
			await convo.startSessions('store-front/main');

			convo.script([toolUse('t1', 'activate', { name: 'scheduler', machine: 'Personal' })]);
			await convo.say('Activate the scheduler workspace on Personal.');

			expect(convo.store.state.active).toContain('vm1:scheduler/main');
			expect(convo.store.state.sessions['vm1:scheduler/main']?.status).toBe('starting');

			convo.script([toolUse('t2', 'switch_view', { ref: 'vm1:scheduler/main' })]);
			await convo.say('Yes.');

			expect(convo.heard).toEqual([
				'> Activate the scheduler workspace on Personal.',
				'Activated scheduler, main on Personal. Switch there?',
				'> Yes.',
				'Switching to scheduler, main on Personal.',
			]);
			expect(convo.store.state.view).toEqual({
				kind: 'session',
				ref: 'vm1:scheduler/main',
				from: 'active',
			});
		});

		it('words for an inactive session named in them → "… isn\'t active. Activate it?"; yes activates it and the words go once it is up', async () => {
			const convo = createConversation({
				refs: REFS,
				view: 'store-front/main',
				inactive: ['checkout-api/main'],
			});
			await convo.startSessions('store-front/main');

			convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
			await convo.say('checkout api, is the build green?');

			expect(convo.heard).toEqual([
				'> checkout api, is the build green?',
				"checkout api, main isn't active. Activate it?",
			]);
			expect(convo.store.state.sessions['checkout-api/main']?.status).toBe('stopped');

			convo.script([toolUse('t2', 'activate', { name: 'checkout-api/main' })]);
			await convo.say('Yes.');
			await convo.startSessions('checkout-api/main');

			expect(convo.store.state.active).toContain('checkout-api/main');
			expect(convo.inputs).toContainEqual(
				expect.objectContaining({
					type: 'send',
					ref: 'checkout-api/main',
					text: 'checkout api, is the build green?',
				}),
			);
			expect(
				convo.store.state.sessions['checkout-api/main']?.stream.filter(
					(item) => item.kind === 'user',
				),
			).toEqual([expect.objectContaining({ text: 'checkout api, is the build green?' })]);
		});

		it('"what\'s active?" on a session\'s screen → answered by Voice OS, never forwarded to it', async () => {
			const convo = createConversation({
				refs: REFS,
				view: 'store-front/main',
				inactive: ['signals/main'],
			});
			await convo.startSessions('store-front/main', 'checkout-api/main');

			convo.script(
				[toolUse('t1', 'list_sessions', { active_only: true })],
				[reply('Store front and checkout api are active.')],
			);
			await convo.say("What's active?");

			expect(convo.heard).toEqual(["> What's active?", 'Store front and checkout api are active.']);
			expect(convo.inputs.filter((input) => input.type === 'send')).toEqual([]);
		});

		it('deactivated mid-turn → what it still streams and its last line are never heard', async () => {
			const convo = createConversation({ refs: REFS, view: 'checkout-api/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.store.dispatch({ type: 'send', ref: 'checkout-api/main', text: 'run the tests' });

			convo.store.dispatch({ type: 'deactivate', ref: 'checkout-api/main' });
			convo.store.dispatch({ type: 'text_delta', ref: 'checkout-api/main', text: 'All 214 ' });
			convo.store.dispatch({
				type: 'assistant_text',
				ref: 'checkout-api/main',
				text: 'All 214 tests pass.',
			});
			await convo.answer('checkout-api/main', 'All 214 tests pass.');
			await convo.wait(60_000);

			expect(convo.heard).toEqual([]);
			expect(convo.store.state.meanwhile).toEqual([]);
		});

		it('deactivating a working session → "… is working. Deactivate anyway?"; yes deactivates it', async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.store.dispatch({ type: 'send', ref: 'checkout-api/main', text: 'run the tests' });

			convo.script([toolUse('t1', 'deactivate', { ref: 'checkout-api/main' })]);
			await convo.say('End the checkout api session.');

			expect(convo.heard).toEqual([
				'> End the checkout api session.',
				'checkout api, main is working. Deactivate anyway?',
			]);
			expect(convo.store.state.active).toContain('checkout-api/main');

			convo.script([toolUse('t2', 'deactivate', { ref: 'checkout-api/main' })]);
			await convo.say('Yes.');

			expect(convo.heard.slice(-2)).toEqual(['> Yes.', 'Deactivated checkout api, main.']);
			expect(convo.store.state.active).not.toContain('checkout-api/main');
			expect(convo.store.state.sessions['checkout-api/main']?.status).toBe('stopped');
		});
	});
});
