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
});
