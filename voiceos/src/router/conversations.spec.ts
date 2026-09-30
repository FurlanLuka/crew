// The design's conversations, heard end to end: the real store, kernel, router, narrator and voice,
// with only the model scripted. Each list is what the developer hears, their own words as "> …".
import { describe, expect, it } from 'bun:test';
import { configureLog } from '../log.js';
import { createConversation, reply, toolUse } from '../../test/support/conversation.js';

configureLog({ quiet: true });

const REFS = ['store-front/main', 'checkout-api/main', 'signals/main'];

describe('conversations', () => {
	it('a question in passing to another session → sent; its short answer is heard with its name', async () => {
		const convo = createConversation({ refs: REFS, view: 'store-front/main' });
		await convo.startSessions('store-front/main', 'checkout-api/main');

		convo.script(
			[toolUse('t1', 'send_to', { ref: 'checkout-api/main', kind: 'question' })],
			[reply('')],
		);
		await convo.say('checkout api, is the build green?');
		await convo.answer('checkout-api/main', 'Yes, all 214 tests pass.');

		expect(convo.heard).toEqual([
			'> checkout api, is the build green?',
			'checkout api, main: Yes, all 214 tests pass.',
		]);
	});
});
