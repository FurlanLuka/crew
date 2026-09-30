import { describe, expect, it } from 'bun:test';
import { toLanguages } from './languages.js';

describe('toLanguages', () => {
	it.each([
		[
			['sl', 'en'],
			['en', 'sl'],
		],
		[
			['en', 'en', 'de'],
			['en', 'de'],
		],
		[['xx', 'de'], ['de']],
		[[], ['en']],
		[['xx'], ['en']],
		['en', ['en']],
		[null, ['en']],
	])('%p → %p', (codes, languages) => expect(toLanguages(codes)).toEqual(languages));
});
