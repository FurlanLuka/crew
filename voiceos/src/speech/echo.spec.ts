import { describe, expect, it } from 'bun:test';
import { ECHO_WINDOW_MS, isEcho } from './echo.js';

const NOW_MS = 100_000;

const createLine = (text: string, endedAt: number | null = NOW_MS - 1000) => ({ text, endedAt });

describe('isEcho', () => {
	it('the line Voice OS just said, whole or its start → echo', () => {
		const spoken = [createLine('store front, main: all tests pass. Want me to push?')];
		expect(
			isEcho({ heard: 'store front main all tests pass want me to push', spoken, now: NOW_MS }),
		).toBe(true);
		expect(
			isEcho({
				heard: 'all tests pa',
				spoken: [createLine('all tests pass.', null)],
				now: NOW_MS,
				isPartial: true,
			}),
		).toBe(true);
	});

	it('case and punctuation do not matter', () =>
		expect(
			isEcho({
				heard: 'ALL TESTS, PASS! WANT',
				spoken: [createLine('all tests pass. Want me to push?', NOW_MS - 500)],
				now: NOW_MS,
			}),
		).toBe(true));

	it('the line still playing counts', () =>
		expect(
			isEcho({
				heard: 'dev servers are',
				spoken: [createLine('dev servers are already up.', null)],
				now: NOW_MS,
				isPartial: true,
			}),
		).toBe(true));

	// Seen live: "Which session — signals/main that's on screen…?" answered "Signals main." while it still played.
	it("a short answer in the words of the line is the developer's", () => {
		expect(
			isEcho({
				heard: 'Signals main.',
				spoken: [
					createLine("Which session — signals main that's on screen, or another one?", null),
				],
				now: NOW_MS,
			}),
		).toBe(false);
		expect(
			isEcho({
				heard: 'fix it',
				spoken: [createLine('store front went down. Want Claude to fix it?', NOW_MS - 4000)],
				now: NOW_MS,
			}),
		).toBe(false);
	});

	// What leaks as a line ends would act if routed: approve, fix, read options.
	it('a short final that is the tail of a line playing or just ended → echo', () => {
		expect(
			isEcho({
				heard: 'Allow.',
				spoken: [createLine('checkout wants to run git push. Allow?', null)],
				now: NOW_MS,
			}),
		).toBe(true);
		expect(
			isEcho({
				heard: 'fix it',
				spoken: [createLine('api went down. Want Claude to fix it?', NOW_MS - 500)],
				now: NOW_MS,
			}),
		).toBe(true);
		expect(
			isEcho({
				heard: 'options',
				spoken: [createLine('store asks: which table? Answer it, or say "options".', null)],
				now: NOW_MS,
			}),
		).toBe(true);
	});

	// A leak finalizes after Soniox's end-of-turn wait; QA checks real leaks land inside this.
	it('a line tail counts as echo up to 1.5 s after the line ended, not after', () => {
		expect(
			isEcho({
				heard: 'Allow.',
				spoken: [createLine('checkout wants to run git push. Allow?', NOW_MS - 1500)],
				now: NOW_MS,
			}),
		).toBe(true);
		expect(
			isEcho({
				heard: 'Allow.',
				spoken: [createLine('checkout wants to run git push. Allow?', NOW_MS - 1501)],
				now: NOW_MS,
			}),
		).toBe(false);
	});

	it("yes, no, stop and the like said alone are always the developer's", () => {
		expect(isEcho({ heard: 'stop', spoken: [createLine('say stop', null)], now: NOW_MS })).toBe(
			false,
		);
		expect(
			isEcho({
				heard: 'No.',
				spoken: [createLine('Allow it, yes or no', NOW_MS - 200)],
				now: NOW_MS,
			}),
		).toBe(false);
	});

	it('short words still being heard → echo as a run of a line playing or just ended, so it never cuts itself off', () => {
		expect(
			isEcho({
				heard: 'signals main',
				spoken: [createLine("Which session — signals main that's on screen?", null)],
				now: NOW_MS,
				isPartial: true,
			}),
		).toBe(true);
		expect(
			isEcho({
				heard: 'want me t',
				spoken: [createLine('Want me to push?', null)],
				now: NOW_MS,
				isPartial: true,
			}),
		).toBe(true);
		expect(
			isEcho({
				heard: 'it fix',
				spoken: [createLine('Want Claude to fix it?', null)],
				now: NOW_MS,
				isPartial: true,
			}),
		).toBe(false);
		expect(
			isEcho({
				heard: 'want me to',
				spoken: [createLine('Want me to push?', NOW_MS - 3000)],
				now: NOW_MS,
				isPartial: true,
			}),
		).toBe(false);
	});

	it('a longer leak of a line just said → echo', () =>
		expect(
			isEcho({
				heard: 'which session signals main that',
				spoken: [createLine("Which session — signals main that's on screen?", null)],
				now: NOW_MS,
			}),
		).toBe(true));

	it('a line that ended before the window → not echo', () =>
		expect(
			isEcho({
				heard: 'all tests pass',
				spoken: [createLine('all tests pass.', NOW_MS - ECHO_WINDOW_MS - 1)],
				now: NOW_MS,
			}),
		).toBe(false));

	it('the developer adding their own words → not echo', () =>
		expect(
			isEcho({
				heard: 'tests pass stop and cancel that',
				spoken: [createLine('all tests pass.')],
				now: NOW_MS,
			}),
		).toBe(false));

	it('one misheard word in a long echo → still echo', () =>
		expect(
			isEcho({
				heard: 'store front main all tests past want me to push',
				spoken: [createLine('store front, main: all tests pass. Want me to push?')],
				now: NOW_MS,
			}),
		).toBe(true));

	it('nothing heard, or nothing said → not echo', () => {
		expect(isEcho({ heard: ' , ', spoken: [createLine('all tests pass.')], now: NOW_MS })).toBe(
			false,
		);
		expect(isEcho({ heard: 'open store front', spoken: [], now: NOW_MS })).toBe(false);
	});
});
