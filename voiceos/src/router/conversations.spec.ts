// The design's conversations, heard end to end: the real store, kernel, router, narrator and voice,
// with only the model scripted. Each list is what the developer hears, their own words as "> …".
import { describe, expect, it } from 'bun:test';
import { configureLog } from '../log.js';
import { createConversation, toolUse } from '../../test/support/conversation.js';

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
});
