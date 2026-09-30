import { describe, expect, it } from 'bun:test';
import { chooseSentWords, isVerbatimSpan } from './send.js';
import { judgeAlways } from '../../test/support/english-judge.js';

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
		chooseSentWords({ utterance: SAID, part, earlier, isWhole, judge: judgeAlways('no') });

	it('no part → the words as said', async () =>
		expect(await choose(undefined)).toEqual({ text: SAID, source: 'said' }));

	it('an empty part → the words as said', async () =>
		expect(await choose('   ')).toEqual({ text: SAID, source: 'said' }));

	it('all the words were for this session → the words as said, even beside a part copied from them', async () =>
		expect(await choose('check the logs for the timeout')).toEqual({ text: SAID, source: 'said' }));

	it('a rewrite → the words as said, whatever else the turn did', async () => {
		expect(await choose('Check the timeout logs and explain the retries.')).toEqual({
			text: SAID,
			source: 'said',
		});
		expect(await choose('Check the timeout logs and explain the retries.', false)).toEqual({
			text: SAID,
			source: 'said',
		});
	});

	it('the words did more than this send, and the part is copied word for word → the part', async () =>
		expect(await choose('check the logs for the timeout', false)).toEqual({
			text: 'check the logs for the timeout',
			source: 'part',
		}));

	it('the same words, written ("Slash clear." as /clear) → the written form', async () =>
		expect(
			await chooseSentWords({
				judge: judgeAlways('no'),
				utterance: 'Slash clear.',
				part: '/clear',
				earlier: [],
				isWhole: true,
			}),
		).toEqual({ text: '/clear', source: 'part' }));

	it('earlier words resent ("I meant this for store front main") → those words', async () =>
		expect(
			await chooseSentWords({
				judge: judgeAlways('no'),
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

	it('a take-back (the judge says the part follows one) → only that part, even when nothing else happened', async () => {
		const said = 'Run the whole suite, actually scratch that, just run the router tests.';
		const choose = (verdict: string) =>
			chooseSentWords({
				judge: judgeAlways(verdict),
				utterance: said,
				part: 'just run the router tests.',
				earlier: [],
				isWhole: true,
			});

		expect(await choose('yes')).toEqual({ text: 'just run the router tests.', source: 'part' });
		// No take-back heard, or the check could not tell: everything they said goes.
		expect(await choose('no')).toEqual({ text: said, source: 'said' });
		expect(await choose('unclear')).toEqual({ text: said, source: 'said' });
	});

	it('the judge is not asked when the part is not word for word: a rewrite never passes', async () => {
		let asked = 0;

		const judge = async () => {
			asked += 1;

			return 'yes' as never;
		};

		const said = 'Scratch that, run the router tests.';

		expect(
			await chooseSentWords({
				judge,
				utterance: said,
				part: 'Run router tests only',
				earlier: [],
				isWhole: true,
			}),
		).toEqual({ text: said, source: 'said' });
		expect(asked).toBe(0);
	});

	it('no words heard (a typed test turn) → the part', async () =>
		expect(
			await chooseSentWords({
				judge: judgeAlways('no'),
				utterance: undefined,
				part: 'Run the tests.',
				earlier: [],
				isWhole: false,
			}),
		).toEqual({ text: 'Run the tests.', source: 'part' }));
});
