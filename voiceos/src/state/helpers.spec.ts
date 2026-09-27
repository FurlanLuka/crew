import { describe, expect, it } from 'bun:test';
import { truncateText } from './helpers.js';

describe('truncateText', () => {
	it('short text is kept whole', () => expect(truncateText('abc', 5)).toBe('abc'));
	it('long text is cut to the limit, marked with an ellipsis', () =>
		expect(truncateText('abcdef', 3)).toBe('abc…'));
});
