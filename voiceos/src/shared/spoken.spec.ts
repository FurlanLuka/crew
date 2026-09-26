import { describe, expect, it } from 'bun:test';
import { INTERRUPT_PATTERN, normalizeUtterance } from './spoken.js';

describe('normalizeUtterance', () => {
	it('lowercases, trims, drops trailing punctuation and quotes', () =>
		expect(normalizeUtterance('  “Yes, please!”  ')).toBe('yes, please'));
});

describe('INTERRUPT_PATTERN', () => {
	it.each(['stop', 'wait', 'hold on', 'cancel that'])('%p is an interrupt word', (word) =>
		expect(INTERRUPT_PATTERN.test(word)).toBe(true),
	);
	it('a sentence is not', () => expect(INTERRUPT_PATTERN.test('stop the dev servers')).toBe(false));
});
