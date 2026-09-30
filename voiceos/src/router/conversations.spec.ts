// The design's conversations, heard end to end: the real store, kernel, router, narrator and voice,
// with only the model scripted. Each list is what the developer hears, their own words as "> …".
import { describe, expect, it } from 'bun:test';
import { configureLog } from '../log.js';
import { createConversation, toolUse } from '../../test/support/conversation.js';
import { SWITCH_OFFER_MS } from '../shared/protocol.js';

configureLog({ quiet: true });

const REFS = ['store-front/main', 'checkout-api/main', 'signals/main'];

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
			'Switch to checkout api, main?',
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
		convo.store.dispatch({
			type: 'spoken',
			text: 'checkout api, main is done: the retry backoff.',
			source: 'narrator',
			ref: 'checkout-api/main',
		});

		convo.script([toolUse('t1', 'ask_target', { ref: 'checkout-api/main' })]);
		await convo.say('Okay, can you do a deep review of all of this?');
		await convo.say('No.');

		expect(convo.heard).toEqual([
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

	it('"For …?" answered yes → the words go there, said; silence keeps them on the screen', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		const notify = () =>
			convo.store.dispatch({
				type: 'spoken',
				text: 'checkout api, main is done: the retry backoff.',
				source: 'narrator',
				ref: 'checkout-api/main',
			});

		notify();
		convo.script([toolUse('t1', 'ask_target', { ref: 'checkout-api/main' })]);
		await convo.say('Can you review all of it?');
		await convo.say('Yes.');

		notify();
		convo.script([toolUse('t2', 'ask_target', { ref: 'checkout-api/main' })]);
		await convo.say('And the docs too?');
		await convo.wait(9_000);

		expect(convo.heard).toEqual([
			'> Can you review all of it?',
			'For checkout api, main?',
			'> Yes.',
			'Sent to checkout api, main.',
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
			'Meanwhile, checkout api, main finished add backoff to the retries.',
		);
		expect(convo.store.state.meanwhile).toEqual([]);
	});

	it('"what did I miss?" → the waiting updates now, without waiting for the quiet', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');
		convo.store.dispatch({
			type: 'meanwhile_added',
			ref: 'checkout-api/main',
			kind: 'done',
			about: 'the retry backoff',
		});

		convo.script([toolUse('t1', 'play_missed', {})]);
		await convo.say('What did I miss?');

		expect(convo.heard).toEqual([
			'> What did I miss?',
			'Meanwhile, checkout api, main finished the retry backoff.',
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

		await convo.wait(2_100);

		// On another session's screen the ask is announced, not asked: its question waits there.
		expect(convo.heard.at(-1)).toBe(
			'checkout-api/main needs you: approval to run git push origin main.',
		);
	});

	describe('timing', () => {
		const offerAfterTwoTurns = async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.script([toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
			await convo.say('checkout api, is the build green?');
			await convo.answer('checkout-api/main', 'Yes, all 214 tests pass.');
			convo.script([toolUse('t2', 'send_to', { ref: 'checkout-api/main', kind: 'question' })]);
			await convo.say('And the lint?');
			await convo.answer('checkout-api/main', 'Lint is clean.');

			return convo;
		};

		it('"Switch to …?" unanswered → let go after 8 s', async () => {
			const convo = await offerAfterTwoTurns();
			expect(convo.store.state.switchOffer?.ref).toBe('checkout-api/main');

			await convo.wait(SWITCH_OFFER_MS + 1);

			expect(convo.store.state.switchOffer).toBeNull();
		});

		it('"Switch to …?" answered yes → switched there, and said', async () => {
			const convo = await offerAfterTwoTurns();

			convo.script([toolUse('t3', 'switch_view', { ref: 'checkout-api/main' })]);
			await convo.say('Yes.');

			expect(convo.store.state.view).toEqual({ kind: 'session', ref: 'checkout-api/main' });
			expect(convo.heard.slice(-2)).toEqual(['> Yes.', 'Switching to checkout api, main.']);
		});

		it('"For …?" answered with new words → the held ones stay on the screen, the new ones are routed', async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.store.dispatch({
				type: 'spoken',
				text: 'checkout api, main is done: the retry backoff.',
				source: 'narrator',
				ref: 'checkout-api/main',
			});

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

		it('listening: the meanwhile line waits 12 s of quiet, not 8', async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main', isListening: true });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.store.dispatch({
				type: 'meanwhile_added',
				ref: 'checkout-api/main',
				kind: 'done',
				about: 'the retries',
			});

			await convo.wait(9_000);
			expect(convo.heard).toEqual([]);

			await convo.wait(3_100);
			expect(convo.heard).toEqual(['Meanwhile, checkout api, main finished the retries.']);
		});

		it('never quiet for long → the update still comes at the first gap after 50 s', async () => {
			const convo = createConversation({ refs: REFS, view: 'store-front/main' });
			await convo.startSessions('store-front/main', 'checkout-api/main');
			convo.store.dispatch({
				type: 'meanwhile_added',
				ref: 'checkout-api/main',
				kind: 'done',
				about: 'the retries',
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
				'Meanwhile, checkout api, main finished the retries.',
			);

			// Never 8 s of quiet, but at 50 s the gap after "line at 45" is the one.
			expect(convo.heard.slice(meanwhileAt - 1, meanwhileAt + 2)).toEqual([
				'line at 45',
				'Meanwhile, checkout api, main finished the retries.',
				'line at 50',
			]);
		});
	});
});
