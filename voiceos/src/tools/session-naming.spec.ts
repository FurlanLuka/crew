import { describe, expect, it } from 'bun:test';
import { createInitialState } from '../state/reducer.js';
import type { State } from '../shared/protocol.js';
import { readNamedInstead } from './session-naming.js';
import { createSession } from '../state/reducer.js';
import { findSessionsNamedIn } from './session-naming.js';

const chatState = (label: string, names: Record<string, string> = {}): State => {
	const refs = ['checkout-api/main', 'chat/3fa9c1'];
	const sessions = Object.fromEntries(
		refs.map((ref) => [
			ref,
			createSession({
				ref,
				label: ref === 'chat/3fa9c1' ? label : ref,
				branch: '',
				cwd: '/w',
				dirs: [],
				isPinned: false,
				...(ref === 'chat/3fa9c1'
					? { isChat: true as const, ...(label === 'chat' ? {} : { chatName: label }) }
					: {}),
			}),
		]),
	);

	return { ...createInitialState(), sessions, order: refs, active: refs, names };
};

describe("a plain session's name", () => {
	it('its crew name is its given name: "ask research…" names it', () =>
		expect(findSessionsNamedIn(chatState('research'), 'ask research what it found')).toEqual([
			'chat/3fa9c1',
		]));

	it('an unnamed one is never named by the word chat', () =>
		expect(findSessionsNamedIn(chatState('chat'), "let's chat about the release")).toEqual([]));

	it("Voice OS's own name wins over the crew name", () => {
		const state = chatState('research', { 'chat/3fa9c1': 'reading list' });

		expect(findSessionsNamedIn(state, 'ask the reading list')).toEqual(['chat/3fa9c1']);
		expect(findSessionsNamedIn(state, 'ask research')).toEqual([]);
	});

	// Decided: a name the developer gave wins over a workspace word, as for any named session.
	it('named "checkout" beside checkout-api/main → "checkout" is the plain session', () =>
		expect(findSessionsNamedIn(chatState('checkout'), 'ask checkout about it')).toEqual([
			'chat/3fa9c1',
		]));
});

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
