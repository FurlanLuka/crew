import { describe, expect, it } from 'bun:test';
import type { SpokenLine, State } from '../../shared/protocol.js';
import { isShownOn } from './LastSpokenLine.js';

const onScreen: State['view'] = { kind: 'session', ref: 'store-front/main' };
const line = (patch: Partial<SpokenLine>): SpokenLine => ({
	id: 's1',
	text: 'Checkout api, main: all tests pass.',
	source: 'narrator',
	at: 1,
	...patch,
});

describe('isShownOn', () => {
	it("another session's narration on a session's screen → hidden: it would read as this one's", () => {
		expect(isShownOn(line({ ref: 'checkout-api/main' }), onScreen)).toBe(false);
	});

	it('the meanwhile line about another session ("… Switch there?") → shown wherever they are', () => {
		expect(
			isShownOn(line({ ref: 'checkout-api/main', isUpdate: true, isAsking: true }), onScreen),
		).toBe(true);
	});

	it("this session's own line, Voice OS's words, and any line off a session screen → shown", () => {
		expect(isShownOn(line({ ref: 'store-front/main' }), onScreen)).toBe(true);
		expect(isShownOn(line({ ref: 'checkout-api/main', source: 'kernel' }), onScreen)).toBe(true);
		expect(isShownOn(line({ ref: 'checkout-api/main' }), { kind: 'active' })).toBe(true);
	});
});
