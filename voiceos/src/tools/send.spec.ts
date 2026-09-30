import { describe, expect, it } from 'bun:test';
import { chooseSentWords, isVerbatimSpan } from './send.js';

describe('isVerbatimSpan', () => {
	it.each([
		['check the logs', 'Restart the servers and have it check the logs.', true],
		['Check the logs.', 'restart, then check   the logs please', true],
		['/clear', 'Slash clear.', true],
		['store-front main', 'send it to store front main', true],
		["don't touch it", 'Dont touch it, okay?', true],
		['test', 'run the tests', false],
		['check the log files', 'check the logs', false],
		['', 'anything', false],
		['a much longer part than the words', 'short', false],
	])('%p in %p → %p', (part, words, expected) =>
		expect(isVerbatimSpan(part, words)).toBe(expected),
	);
});

describe('chooseSentWords', () => {
	const SAID = 'Um, can you ask it to check the logs for the timeout, and, uh, why it retries?';
	const choose = (part: string | undefined, isWhole = true, earlier: string[] = []) =>
		chooseSentWords({ utterance: SAID, part, earlier, isWhole });

	it('no part → the words as said', () =>
		expect(choose(undefined)).toEqual({ text: SAID, source: 'said' }));

	it('an empty part → the words as said', () =>
		expect(choose('   ')).toEqual({ text: SAID, source: 'said' }));

	it('all the words were for this session → the words as said, even beside a part copied from them', () =>
		expect(choose('check the logs for the timeout')).toEqual({ text: SAID, source: 'said' }));

	it('a rewrite → the words as said, whatever else the turn did', () => {
		expect(choose('Check the timeout logs and explain the retries.')).toEqual({
			text: SAID,
			source: 'said',
		});
		expect(choose('Check the timeout logs and explain the retries.', false)).toEqual({
			text: SAID,
			source: 'said',
		});
	});

	it('the words did more than this send, and the part is copied word for word → the part', () =>
		expect(choose('check the logs for the timeout', false)).toEqual({
			text: 'check the logs for the timeout',
			source: 'part',
		}));

	it('the same words, written ("Slash clear." as /clear) → the written form', () =>
		expect(
			chooseSentWords({ utterance: 'Slash clear.', part: '/clear', earlier: [], isWhole: true }),
		).toEqual({ text: '/clear', source: 'part' }));

	it('earlier words resent ("I meant this for store front main") → those words', () =>
		expect(
			chooseSentWords({
				utterance: 'Um, sorry, I meant this for store front main.',
				part: 'After commit, can you just directly rebuild and restart',
				earlier: [
					'After commit, can you just directly rebuild and restart so we can have it right away?',
				],
				isWhole: true,
			}),
		).toEqual({
			text: 'After commit, can you just directly rebuild and restart',
			source: 'earlier',
		}));

	it('a take-back → only what follows it, even when nothing else happened', () => {
		const said = 'Run the whole suite, actually scratch that, just run the router tests.';

		expect(
			chooseSentWords({
				utterance: said,
				part: 'just run the router tests.',
				earlier: [],
				isWhole: true,
			}),
		).toEqual({ text: 'just run the router tests.', source: 'part' });
		// A part from before the take-back is not what they meant: the words as said.
		expect(
			chooseSentWords({ utterance: said, part: 'Run the whole suite', earlier: [], isWhole: true }),
		).toEqual({ text: said, source: 'said' });
	});

	it('"ignore" inside an instruction is no take-back → the words as said', () =>
		expect(
			chooseSentWords({
				utterance: 'Tell it to ignore the flaky test.',
				part: 'the flaky test',
				earlier: [],
				isWhole: true,
			}),
		).toEqual({ text: 'Tell it to ignore the flaky test.', source: 'said' }));

	it('no words heard (a typed test turn) → the part', () =>
		expect(
			chooseSentWords({
				utterance: undefined,
				part: 'Run the tests.',
				earlier: [],
				isWhole: false,
			}),
		).toEqual({ text: 'Run the tests.', source: 'part' }));
});
