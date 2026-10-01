import { describe, expect, it } from 'bun:test';
import { SETUP_REF } from '../shared/machine-ref.js';
import { createInitialState } from '../state/reducer.js';
import type { Effect } from '../state/reducer.js';
import { isSilenced, listReadBackRefs } from './connect.js';

describe('isSilenced', () => {
	const ACTIVE = 'store/main';
	const INACTIVE = 'checkout/main';
	const state = { ...createInitialState(), active: [ACTIVE] };
	const speak = (patch: Partial<Extract<Effect, { type: 'speak' }>>): Effect => ({
		type: 'speak',
		text: 'Tests pass.',
		source: 'narrator',
		...patch,
	});
	const narrate = (ref: string): Effect => ({
		type: 'narrate',
		ref,
		text: 'Done.',
		asked: null,
		isOwed: false,
		spoken: null,
		isSpokenAlready: false,
		isHeld: false,
		hasBackgroundAgents: false,
	});
	const aside = (ref: string): Effect => ({
		type: 'narrate_aside',
		ref,
		question: 'which branch?',
		answer: 'main',
	});

	it('a line, a narration or an aside of an inactive session → silenced', () => {
		expect(isSilenced(state, speak({ ref: INACTIVE }))).toBe(true);
		expect(isSilenced(state, speak({ ref: INACTIVE, source: 'alert' }))).toBe(true);
		expect(isSilenced(state, narrate(INACTIVE))).toBe(true);
		expect(isSilenced(state, aside(INACTIVE))).toBe(true);
	});

	it("the same of an active session, or of this Mac's setup → said", () => {
		expect(isSilenced(state, speak({ ref: ACTIVE }))).toBe(false);
		expect(isSilenced(state, narrate(ACTIVE))).toBe(false);
		expect(isSilenced(state, aside(ACTIVE))).toBe(false);
		expect(isSilenced(state, narrate(SETUP_REF))).toBe(false);
	});

	it('Voice OS\'s reply about an inactive session ("… isn\'t active. Activate it?") → said', () => {
		expect(isSilenced(state, speak({ ref: INACTIVE, source: 'kernel', isReply: true }))).toBe(
			false,
		);
	});

	it('a kernel line about an inactive session that answers nothing → silenced', () => {
		expect(isSilenced(state, speak({ ref: INACTIVE, source: 'kernel' }))).toBe(true);
	});

	it('a line about no session, and effects that say nothing → never silenced', () => {
		expect(isSilenced(state, speak({}))).toBe(false);
		expect(isSilenced(state, { type: 'drop_speech', ref: INACTIVE, before: 0 })).toBe(false);
		expect(isSilenced(state, { type: 'worker_stop', ref: INACTIVE })).toBe(false);
	});
});

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
