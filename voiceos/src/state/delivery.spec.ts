import { describe, expect, it } from 'bun:test';
import type { SessionStatus } from '../shared/protocol.js';
import { decideDelivery } from './delivery.js';

describe('decideDelivery', () => {
	it.each<[SessionStatus, 'question' | 'instruction' | undefined, string, 'send' | 'aside']>([
		['running', 'question', 'which file did you change?', 'aside'],
		['running', 'instruction', 'also run the linter', 'send'],
		['running', undefined, 'which file did you change?', 'send'],
		['running', 'instruction', 'btw, run the linter too', 'aside'],
		['running', undefined, 'By the way, which file?', 'aside'],
		['running', 'question', 'BY THE WAY what changed', 'aside'],
		['running', 'question', 'queue it: what changed?', 'send'],
		['running', 'question', 'by the way, queue it', 'aside'],
		['running', 'instruction', 'check btwn the two files', 'send'],
		['running', 'instruction', 'look at the subtweet handler', 'send'],
		['idle', 'question', 'by the way, which file?', 'send'],
		['blocked', 'question', 'which file?', 'aside'],
		['blocked', 'instruction', 'use the new table instead', 'send'],
		['starting', 'question', 'which file?', 'send'],
		['stopped', 'question', 'btw which file?', 'send'],
	])('%s, %s, %p → %s', (status, kind, utterance, delivery) =>
		expect(decideDelivery({ status, kind, utterance })).toBe(delivery),
	);
});
