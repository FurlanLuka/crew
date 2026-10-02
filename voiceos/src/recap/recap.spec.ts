import { describe, expect, it } from 'bun:test';
import { createToolContext } from '../../test/support/tool-context.js';
import { permissionAsk } from '../../test/support/reduce.js';
import type { State } from '../shared/protocol.js';
import type { HistoryEntry } from '../tools/tools.js';
import {
	buildRecapMessage,
	composeRecapFallback,
	describeWindow,
	gatherRecap,
	type RecapInput,
} from './recap.js';

const NOW = Date.parse('2026-10-02T15:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const turn = (
	ref: string,
	minutes: number,
	did: string,
	asked: string | null = null,
): HistoryEntry => ({
	ts: minutesAgo(minutes),
	ref,
	asked,
	did,
});

// store-front/main and store-front/wrk1 idle, checkout-api/main stopped; all three active.
const stateWith = (patch: Partial<State> = {}): State => createToolContext(patch).tools.getState();

const gather = (history: HistoryEntry[], patch: Partial<State> = {}, ref: string | null = null) =>
	gatherRecap({ state: stateWith(patch), history, ref, minutes: 60, now: NOW });

describe('gatherRecap', () => {
	it('every active session that moved in the window, newest turns first; quiet ones left out', () => {
		const recap = gather([
			turn('checkout-api/main', 5, 'All retry tests pass.', 'run the retry tests'),
			turn('checkout-api/main', 30, 'Added the backoff.'),
			turn('store-front/main', 90, 'Too old to count.'),
		]);

		expect(recap.window).toBe('the last hour');
		expect(recap.isOneSession).toBe(false);
		expect(recap.sessions.map((session) => session.ref)).toEqual(['checkout-api/main']);
		expect(recap.sessions[0]?.turns).toEqual([
			{ asked: 'run the retry tests', did: 'All retry tests pass.', ago: '5m' },
			{ asked: null, did: 'Added the backoff.', ago: '30m' },
		]);
	});

	it('what waits on the developer, and what it said they have not heard, count as moving', () => {
		const recap = gather([], {
			asks: [permissionAsk('p1', 'store-front/main')],
			meanwhile: [{ ref: 'store-front/wrk1', kind: 'done', about: 'the cart is fixed', at: NOW }],
		});

		expect(recap.sessions).toEqual([
			expect.objectContaining({
				ref: 'store-front/main',
				waits: [expect.stringMatching(/^wants to /)],
			}),
			expect.objectContaining({ ref: 'store-front/wrk1', unheard: 'the cart is fixed' }),
		]);
	});

	it('one session asked about → that one, even with nothing new; a session not active → left out', () => {
		expect(gather([], {}, 'store-front/wrk1').sessions).toEqual([
			expect.objectContaining({ ref: 'store-front/wrk1', turns: [], waits: [], unheard: null }),
		]);
		expect(
			gather([turn('checkout-api/main', 5, 'Done.')], { active: ['store-front/main'] }).sessions,
		).toEqual([]);
	});

	it('the time asked about, said the way it was asked', () => {
		expect(describeWindow(30)).toBe('the last 30 minutes');
		expect(describeWindow(60)).toBe('the last hour');
		expect(describeWindow(180)).toBe('the last 3 hours');
	});
});

const RECAP: RecapInput = {
	window: 'the last hour',
	isOneSession: false,
	sessions: [
		{
			ref: 'checkout-api/main',
			label: 'checkout api',
			status: 'idle',
			waits: ['asks: push to main?'],
			unheard: null,
			turns: [{ asked: 'run the retry tests', did: 'All retry tests pass.', ago: '5m' }],
		},
		{
			ref: 'store-front/main',
			label: 'store front',
			status: 'running',
			waits: [],
			unheard: 'The cart page renders again.',
			turns: [],
		},
	],
};

describe('buildRecapMessage', () => {
	it('the time asked about, then each session: status, what waits, what was not heard, its turns', () =>
		expect(buildRecapMessage(RECAP)).toBe(
			[
				'time asked about: the last hour',
				'about every active session',
				'session "checkout api" (idle)',
				'  waits on the developer: asks: push to main?',
				'  5m ago — asked: run the retry tests — did: All retry tests pass.',
				'session "store front" (running)',
				'  said, not heard yet: The cart page renders again.',
			].join('\n'),
		));
});

describe('composeRecapFallback', () => {
	it("what waits first, then each session's latest, the unheard over the last turn", () =>
		expect(composeRecapFallback(RECAP)).toBe(
			'checkout api asks: push to main. checkout api: All retry tests pass. store front: The cart page renders again.',
		));

	it('nothing moved → said so for the time asked about', () =>
		expect(composeRecapFallback({ ...RECAP, window: 'the last 30 minutes', sessions: [] })).toBe(
			'Nothing new in the last 30 minutes.',
		));
});
