import { describe, expect, it } from 'bun:test';
import { listReadBackRefs } from './connect.js';

describe('listReadBackRefs', () => {
	it('read_state and read_history of other sessions → those sessions, once each', () => {
		expect(
			listReadBackRefs(
				[
					{ name: 'read_state', input: { ref: 'checkout/main' }, ok: true },
					{ name: 'read_history', input: { ref: 'signals/main' }, ok: true },
					{ name: 'read_state', input: { ref: 'checkout/main' }, ok: true },
				],
				'store/main',
			),
		).toEqual(['checkout/main', 'signals/main']);
	});

	it('the session on screen, a failed read, a read of every session, another tool → nothing', () => {
		expect(
			listReadBackRefs(
				[
					{ name: 'read_state', input: { ref: 'store/main' }, ok: true },
					{ name: 'read_state', input: { ref: 'nope/main' }, ok: false },
					{ name: 'read_state', input: {}, ok: true },
					{ name: 'read_history', input: { ref: null }, ok: true },
					{ name: 'send_to', input: { ref: 'checkout/main' }, ok: true },
					{ name: 'read_state' },
				],
				'store/main',
			),
		).toEqual([]);
	});
});
