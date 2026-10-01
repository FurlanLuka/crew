import { describe, expect, it } from 'bun:test';
import { createInitialState } from '../state/reducer.js';
import type { State } from '../shared/protocol.js';
import { readNamedInstead } from './session-naming.js';

const ORDER = ['store-front/main', 'store-front/wrk1', 'checkout-api/main', 'signals/main'];

const withNames = (names: Record<string, string>, order = ORDER): State => ({
	...createInitialState(),
	order,
	names,
});

describe('readNamedInstead', () => {
	// Debug note 14: "go back to speak main" went to speak/main, not the session named Speak Main.
	it('the name of another session, sounding like the asked ref → that session', () => {
		const state = withNames({ 'store-front/wrk1': 'Store Front Main' });

		expect(
			readNamedInstead(state, 'store-front/main', 'Can you go back to store front main?'),
		).toBe('store-front/wrk1');
	});

	it('a name said inside a longer spoken ref → kept', () => {
		const state = withNames({ 'signals/main': 'Store' });

		expect(readNamedInstead(state, 'store-front/main', 'switch to store front main')).toBeNull();
	});

	it('a named session mentioned in passing beside another target → kept', () => {
		const state = withNames({ 'store-front/wrk1': 'Store Front Main' });

		expect(
			readNamedInstead(
				state,
				'checkout-api/main',
				'Tell store front main the tests pass, then switch to checkout api main.',
			),
		).toBeNull();
	});

	it("the target's own name said → kept", () => {
		const state = withNames({ 'checkout-api/main': 'Store Front Main' });

		expect(readNamedInstead(state, 'checkout-api/main', 'Switch to store front main.')).toBeNull();
	});

	it('two sessions whose names both match → kept: no guess between them', () => {
		const order = [...ORDER, 'vm1:store-front/wrk1'];
		const state = withNames(
			{ 'store-front/wrk1': 'Store Front Main', 'vm1:store-front/wrk1': 'store-front main' },
			order,
		);

		expect(readNamedInstead(state, 'store-front/main', 'Go back to store front main.')).toBeNull();
	});
});
