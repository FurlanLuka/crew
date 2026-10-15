import { describe, expect, it } from 'bun:test';
import { filterMentions, insertMention, readMention } from './mentions.js';

describe('readMention', () => {
	it.each([
		['@sto', 4, 'sto'],
		['fix @store/wr', 13, 'store/wr'],
		['fix @', 5, ''],
		['fix @store/wrk1 now', 9, 'stor'],
	])('%s, caret %i → typed %s', (text, caret, typed) =>
		expect(readMention(text, caret)?.typed).toBe(typed),
	);

	it('mail@host is not one; no @ before the caret is not one', () => {
		expect(readMention('mail@host', 9)).toBeNull();
		expect(readMention('fix store', 9)).toBeNull();
		expect(readMention('@store now', 10)).toBeNull();
	});

	it('says where it starts (the @) and ends (the caret)', () =>
		expect(readMention('fix @sto', 8)).toEqual({ start: 4, end: 8, typed: 'sto' }));
});

describe('filterMentions', () => {
	const WORKTREES = ['store/main', 'store/wrk1', 'signals/main'];
	const PROJECTS = ['store-front', 'store-api', 'checkout-api'];

	it('nothing typed → worktrees first, then projects', () =>
		expect(filterMentions('', WORKTREES, PROJECTS).map((entry) => entry.value)).toEqual([
			...WORKTREES,
			...PROJECTS,
		]));

	it('a start of the name ranks before a start of a part, before anywhere in it', () =>
		expect(filterMentions('api', WORKTREES, PROJECTS).map((entry) => entry.value)).toEqual([
			'store-api',
			'checkout-api',
		]));

	it('case does not matter; kinds are said', () =>
		expect(filterMentions('WRK', WORKTREES, PROJECTS)).toEqual([
			{ value: 'store/wrk1', kind: 'worktree' },
		]));
});

describe('insertMention', () => {
	it('the @word becomes the name and a space; the caret lands after it', () => {
		const text = 'fix @sto now';
		const mention = readMention(text, 8);

		expect(mention && insertMention(text, mention, 'store/wrk1')).toEqual({
			text: 'fix store/wrk1 now',
			caret: 15,
		});
	});

	it('at the end of the box', () => {
		const mention = readMention('@si', 3);

		expect(mention && insertMention('@si', mention, 'signals/main')).toEqual({
			text: 'signals/main ',
			caret: 13,
		});
	});
});
