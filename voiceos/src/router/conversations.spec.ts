// The design's conversations, heard end to end: the real store, kernel, router, narrator and voice,
// with only the model scripted. Each list is what the developer hears, their own words as "> …".
import { describe, expect, it } from 'bun:test';
import { configureLog } from '../log.js';
import { createConversation, reply, toolUse } from '../../test/support/conversation.js';
import { SWITCH_OFFER_MS, type PendingAsk } from '../shared/protocol.js';
import { englishJudge } from '../../test/support/english-judge.js';
import type { Judge } from '../judge/judge.js';

configureLog({ quiet: true });

const REFS = ['store-front/main', 'checkout-api/main', 'signals/main'];

// Checkout finishes while the developer looks elsewhere; its update is said in the meanwhile line.
const UPDATE =
	'The retry backoff now doubles from one second up to thirty, and every retry test passes again.';
const MEANWHILE_LINE =
	'Meanwhile, checkout api, main said: The retry backoff now doubles from one second up to thirty, and every retry…';

const hearUpdate = async (convo: ReturnType<typeof createConversation>): Promise<void> => {
	await convo.answer('checkout-api/main', UPDATE);
	await convo.wait(9_000);
};

describe('conversations', () => {
	it('a question in passing to another session → sent; its short answer is heard with its name', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
		await convo.say('checkout api, is the build green?');
		await convo.answer('checkout-api/main', 'Yes, all 214 tests pass.');

		expect(convo.heard).toEqual([
			'> checkout api, is the build green?',
			'Sent to checkout api, main.',
			'checkout api, main: Yes, all 214 tests pass.',
		]);
	});

	it('a question in passing (design 3): the subject answers in full, however long; words for the screen say where they went', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		const longAnswer =
			'Lint is clean across all four packages, and the two warnings from yesterday are gone after the config change.';

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
		await convo.say('checkout api, is the build green?');
		await convo.answer('checkout-api/main', 'Yes, all 214 tests pass.');

		convo.script([toolUse('t2', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
		await convo.say('And the lint?');
		await convo.answer('checkout-api/main', longAnswer);

		convo.script([toolUse('t3', 'forward', { kind: 'instruction' })]);
		await convo.say('Okay, run the tests here.');

		expect(convo.heard).toEqual([
			'> checkout api, is the build green?',
			'Sent to checkout api, main.',
			'checkout api, main: Yes, all 214 tests pass.',
			'> And the lint?',
			'Sent to checkout api, main.',
			`checkout api, main: ${longAnswer}`,
			'> Okay, run the tests here.',
			'Sent to store front, main.',
		]);
		expect(convo.store.state.exchange?.ref).toBe('store-front/main');
	});

	it('a minute after its last answer heard, the subject lapses', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
		await convo.say('checkout api, is the build green?');
		await convo.answer('checkout-api/main', 'Yes, all 214 tests pass.');
		await convo.wait(61_000);

		expect(convo.store.state.exchange).toBeNull();
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
		expect(convo.store.state.view).toEqual({ kind: 'session', ref: 'store-front/main' });
	});

	it('the incident done right: words that could be for the notifier → "For …?"; no keeps them on the screen', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		await hearUpdate(convo);

		convo.script([toolUse('t1', 'ask_target', { ref: 'checkout-api/main' })]);
		await convo.say('Okay, can you do a deep review of all of this?');
		await convo.say('No.');

		expect(convo.heard).toEqual([
			MEANWHILE_LINE,
			'> Okay, can you do a deep review of all of this?',
			'For checkout api, main?',
			'> No.',
			'Kept on store front, main.',
		]);
		expect(convo.inputs).toContainEqual(
			expect.objectContaining({
				type: 'send',
				ref: 'store-front/main',
				text: 'Okay, can you do a deep review of all of this?',
			}),
		);
	});

	it('"For …?" open, and the developer types "no" into the session\'s box → typed to that session, not the answer', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		await hearUpdate(convo);
		convo.script([toolUse('t1', 'ask_target', { ref: 'checkout-api/main' })]);
		await convo.say('Can you review all of it?');

		await convo.type('no');

		expect(convo.store.state.targetAsk?.ref).toBe('checkout-api/main');
		expect(convo.inputs).toContainEqual(
			expect.objectContaining({ type: 'send', ref: 'store-front/main', text: 'no' }),
		);
	});

	it('"For …?" asked while the developer was already saying something else → those words are not its answer', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		await hearUpdate(convo);
		convo.script([toolUse('t1', 'ask_target', { ref: 'checkout-api/main' })]);
		await convo.say('Can you review all of it?');

		convo.script([toolUse('t2', 'forward', { kind: 'instruction' })]);
		await convo.say('Yes.', { startedAgoMs: 5_000 });

		// Still open for an answer said after it: this yes began before the question existed.
		expect(convo.store.state.targetAsk?.ref).toBe('checkout-api/main');
	});

	it('"For …?" that played in no tab → let go at once, the words kept on the screen', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.store.dispatch({
			type: 'ask_target',
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

	it('"For …?" answered yes → the words go there, said; silence keeps them on the screen', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		await hearUpdate(convo);
		convo.script([toolUse('t1', 'ask_target', { ref: 'checkout-api/main' })]);
		await convo.say('Can you review all of it?');
		await convo.say('Yes.');

		await hearUpdate(convo);
		convo.script([toolUse('t2', 'ask_target', { ref: 'checkout-api/main' })]);
		await convo.say('And the docs too?');
		await convo.wait(9_000);

		expect(convo.heard).toEqual([
			MEANWHILE_LINE,
			'> Can you review all of it?',
			'For checkout api, main?',
			'> Yes.',
			// A reply to an update heard: the one switch offer, in the ack.
			'Sent to checkout api, main. Switch there?',
			// Talking with checkout now: its next line is said in full, named.
			`checkout api, main: ${UPDATE}`,
			'> And the docs too?',
			'For checkout api, main?',
			'Kept on store front, main.',
		]);
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
			'Meanwhile, checkout api, main said: The retry backoff now doubles from one second up to thirty, and every retry…',
		);
		expect(convo.store.state.meanwhile).toEqual([]);
	});

	it('a question to another session that takes minutes → still the conversation; its answer comes in full, named', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
		await convo.say('Checkout api, run the full suite and tell me if it is green.');
		convo.store.dispatch({ type: 'turn_started', ref: 'checkout-api/main' });

		await convo.wait(180_000);
		expect(convo.store.state.exchange?.ref).toBe('checkout-api/main');

		const answer =
			'212 of 214 pass; the two failures are in the retry jitter tests, both timing out on the slow runner.';
		await convo.answer('checkout-api/main', answer);

		expect(convo.heard.at(-1)).toBe(`checkout api, main: ${answer}`);
		expect(convo.store.state.meanwhile).toEqual([]);
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

	it('a reply to the meanwhile line → the kernel is told checkout was just heard, as a notification', async () => {
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

		// No routing is scripted here: what matters is that the model can see whose update it was.
		expect(convo.kernelSaw()).toMatch(/checkout-api\/main[^\n]*Meanwhile, checkout api, main said/);
		expect(convo.kernelSaw()).toContain("Replying to checkout-api/main's notification");
	});

	it('a reply to an update heard in the meanwhile line → sent there, and the switch offered in the same line', async () => {
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

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Great, push it.');

		expect(convo.heard.at(-1)).toBe('Sent to checkout api, main. Switch there?');
		expect(convo.store.state.switchOffer?.ref).toBe('checkout-api/main');

		convo.script([toolUse('t2', 'switch_view', { ref: 'checkout-api/main' })]);
		await convo.say('Yes.');

		expect(convo.store.state.view).toMatchObject({ kind: 'session', ref: 'checkout-api/main' });
	});

	it('an update waiting but not yet heard → a reply to that session is "Sent to …" alone, no offer', async () => {
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

		expect(convo.heard.at(-1)).toBe('Sent to checkout api, main.');
		expect(convo.store.state.switchOffer).toBeNull();

		// Spoken to, its waiting update is settled: no meanwhile line repeats it later.
		await convo.wait(20_000);
		expect(convo.heard.some((line) => line.startsWith('Meanwhile'))).toBe(false);
	});

	it('the offer is made once per update: a later conversation with it is "Sent to …" alone', async () => {
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
		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Great, push it.');
		expect(convo.heard.at(-1)).toBe('Sent to checkout api, main. Switch there?');

		await convo.wait(120_000);
		convo.script([toolUse('t2', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Checkout api, also open a pull request.');

		expect(convo.heard.at(-1)).not.toEndWith('Switch there?');
		expect(convo.store.state.switchOffer).toBeNull();
	});

	it('a reply to a heard update while that session is at work → one line: when it goes, and the offer', async () => {
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
		// At work on something else again (a turn it started on its own, a background task's report).
		convo.store.dispatch({ type: 'turn_started', ref: 'checkout-api/main' });
		const heardBefore = convo.heard.length;

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Great, push it.');

		const said = convo.heard.slice(heardBefore + 1);
		expect(said).toHaveLength(1);
		expect(said[0]).toEndWith('Switch there?');
		expect(said[0]).not.toStartWith('Sent to');
	});

	it('a meanwhile line naming two sessions → the kernel asks which unless one is named; a reply to either offers the switch', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main', 'signals/main');
		await convo.answer('checkout-api/main', UPDATE);
		await convo.answer(
			'signals/main',
			'The ingest queue drains in under a minute now, and the dashboard shows it live.',
		);
		await convo.wait(9_000);
		expect(convo.heard.at(-1)).toContain('signals, main said:');

		convo.script([toolUse('t1', 'send_to', { ref: 'signals/main', kind: 'instruction' })]);
		await convo.say('Nice, ship it.');

		// One line about both: the kernel is told to ask which, never to pick the newest.
		expect(convo.kernelSaw()).toContain('checkout-api/main and signals/main: "Meanwhile');
		expect(convo.kernelSaw()).toContain('never pick one yourself');
		expect(convo.heard.at(-1)).toBe('Sent to signals, main. Switch there?');
	});

	it('an update heard more than ten minutes ago → a reply to it is "Sent to …" alone', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		await hearUpdate(convo);
		await convo.wait(10 * 60_000 + 1);

		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
		await convo.say('Push it.');

		expect(convo.heard.at(-1)).toBe('Sent to checkout api, main.');
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

	it('a quick question to another session, nothing announced from it → "Sent to …" alone, no offer', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
		await convo.say('Checkout api, is the build green?');

		expect(convo.heard.at(-1)).toBe('Sent to checkout api, main.');
		expect(convo.store.state.switchOffer).toBeNull();
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

		it('a plan → its title only; a bare yes asks "Switch to …?", and a yes to that plays the plan there, unapproved', async () => {
			const convo = await onStoreFront();
			convo.store.dispatch({ type: 'ask_opened', ask: plan });
			await convo.wait(3_100);

			expect(convo.heard.at(-1)).toBe(
				'Meanwhile, checkout api, main has a plan ready: Retry backoff with jitter.',
			);

			convo.script([toolUse('t1', 'answer', { ref: CHECKOUT, decision: 'yes', text: '' })]);
			await convo.say('Yes.');

			expect(convo.heard.at(-1)).toBe('Switch to checkout api, main?');
			expect(convo.store.state.asks.map((ask) => ask.id)).toEqual(['pl1']);

			convo.script([toolUse('t2', 'switch_view', { ref: CHECKOUT })]);
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

		it('talking with checkout → its question is asked now, not saved for the meanwhile line', async () => {
			const convo = await onStoreFront();
			convo.script([toolUse('t1', 'send_to', { ref: CHECKOUT, kind: 'question' })]);
			await convo.say('Checkout api, which database?');
			convo.store.dispatch({ type: 'ask_opened', ask: question('Postgres or SQLite?') });
			await convo.wait(3_100);

			expect(convo.store.state.meanwhile).toEqual([]);
			expect(convo.heard.some((line) => line.includes('Postgres or SQLite?'))).toBe(true);
			expect(convo.heard.some((line) => line.startsWith('Meanwhile'))).toBe(false);
		});
	});

	describe('told about a session by the kernel, then a reply to it', () => {
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
			await convo.say('Tell it to push.');
		};

		it('"where\'s the status?" read back → the reply to it offers the switch, and no meanwhile line repeats it', async () => {
			const convo = await withUpdateWaiting();
			convo.script([toolUse('t1', 'read_state', { ref: 'checkout-api/main' })], [reply(READ_BACK)]);
			await convo.say("Where's the status?");
			expect(convo.store.state.meanwhile).toEqual([]);
			await replyToCheckout(convo);

			expect(convo.heard.slice(-3)).toEqual([
				READ_BACK,
				'> Tell it to push.',
				'Sent to checkout api, main. Switch there?',
			]);

			await convo.wait(60_000);
			expect(convo.heard.some((line) => line.startsWith('Meanwhile'))).toBe(false);
		});

		it('asked about by name → the same', async () => {
			const convo = await withUpdateWaiting();
			convo.script([toolUse('t1', 'read_state', { ref: 'checkout-api/main' })], [reply(READ_BACK)]);
			await convo.say("How's checkout api doing?");
			await replyToCheckout(convo);

			expect(convo.heard.at(-1)).toBe('Sent to checkout api, main. Switch there?');
		});

		it('read from its history → the same', async () => {
			const convo = await withUpdateWaiting();
			convo.script(
				[toolUse('t1', 'read_history', { ref: 'checkout-api/main' })],
				[reply(READ_BACK)],
			);
			await convo.say('What did checkout do earlier?');
			await replyToCheckout(convo);

			expect(convo.heard.at(-1)).toBe('Sent to checkout api, main. Switch there?');
		});

		it('an answer that read every session, none by name → "Sent to …" alone', async () => {
			const convo = await withUpdateWaiting();
			convo.script([toolUse('t1', 'read_state', {})], [reply('Checkout api is idle.')]);
			await convo.say("What's waiting?");
			await replyToCheckout(convo);

			expect(convo.heard.at(-1)).toBe('Sent to checkout api, main.');
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
			'Meanwhile, checkout api, main said: all retry tests pass.',
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

	describe('timing', () => {
		// Checkout's update heard in the meanwhile line, then a reply to it: "Sent to …. Switch there?".
		const offerAfterHeardUpdate = async () => {
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
			convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'instruction' })]);
			await convo.say('Great, push it.');

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

			expect(convo.store.state.view).toEqual({ kind: 'session', ref: 'checkout-api/main' });
			expect(convo.heard.slice(-2)).toEqual(['> Yes.', 'Switching to checkout api, main.']);
		});

		it('"For …?" answered with new words → the held ones stay on the screen, the new ones are routed', async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			await hearUpdate(convo);

			convo.script([toolUse('t1', 'ask_target', { ref: 'checkout-api/main' })]);
			await convo.say('Review all of this.');
			convo.script([toolUse('t2', 'forward', { kind: 'instruction' })]);
			await convo.say('Actually, run the linter on the whole repo first.');

			const sends = convo.inputs.flatMap((input) =>
				input.type === 'send' ? [[input.ref, input.text]] : [],
			);

			expect(sends).toEqual([
				['store-front/main', 'Review all of this.'],
				['store-front/main', 'Actually, run the linter on the whole repo first.'],
			]);
		});

		it('"For …?" answered "no" with more after it → the held words stay on the screen, and the rest is routed too', async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			await hearUpdate(convo);

			convo.script([toolUse('t1', 'ask_target', { ref: 'checkout-api/main' })]);
			await convo.say('Review all of this.');
			convo.script([toolUse('t2', 'forward', { kind: 'instruction' })]);
			await convo.say('No, and run the linter on the whole repo first.');

			const sends = convo.inputs.flatMap((input) =>
				input.type === 'send' ? [[input.ref, input.text]] : [],
			);

			expect(sends).toEqual([
				['store-front/main', 'Review all of this.'],
				['store-front/main', 'No, and run the linter on the whole repo first.'],
			]);
		});

		it('"For …?" answered yes with more after it → the held words go there, and the rest is routed too', async () => {
			// A long yes in another language: the English patterns would call it something else.
			const judge: Judge = async (params) =>
				params.key === 'target_answer' ? ('yes' as never) : englishJudge(params);
			const convo = createConversation({ refs: REFS, view: 'store-front/main', judge });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			await hearUpdate(convo);

			convo.script([toolUse('t1', 'ask_target', { ref: 'checkout-api/main' })]);
			await convo.say('Review all of this.');
			convo.script([toolUse('t2', 'forward', { kind: 'instruction' })]);
			await convo.say('Ja, und danach führ den Linter aus.');

			const sends = convo.inputs.flatMap((input) =>
				input.type === 'send' ? [[input.ref, input.text]] : [],
			);

			expect(sends).toEqual([
				['checkout-api/main', 'Review all of this.'],
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
			expect(convo.heard).toEqual(['Meanwhile, checkout api, main said: all retry tests pass.']);
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
				'Meanwhile, checkout api, main said: all retry tests pass.',
			);

			// Never 8 s of quiet, but at 50 s the gap after "line at 45" is the one.
			expect(convo.heard.slice(meanwhileAt - 1, meanwhileAt + 2)).toEqual([
				'line at 45',
				'Meanwhile, checkout api, main said: all retry tests pass.',
				'line at 50',
			]);
		});
	});
});
