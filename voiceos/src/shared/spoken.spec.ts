import { describe, expect, it } from 'bun:test';
import { cleanSessionLine, INTERRUPT_PATTERN, normalizeUtterance } from './spoken.js';

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

describe('cleanSessionLine', () => {
	const sentence =
		'The parser now handles nested quotes and escaped brackets correctly everywhere.';

	it('a 105-word line → whole, still cleaned for speech', () => {
		const line = `${`${sentence} `.repeat(9)}Should I push \`main\` now?`;

		expect(cleanSessionLine(line)).toBe(`${`${sentence} `.repeat(9)}Should I push now?`);
	});

	it('250 words → cut at the last sentence end within 200 words', () => {
		// 25 sentences of 10 words: the 20th ends on word 200.
		const tenWords = 'The parser handles nested quotes and escaped brackets correctly now.';
		const line = `${tenWords} `.repeat(25).trim();

		expect(cleanSessionLine(line)).toBe(`${tenWords} `.repeat(20).trim());
		expect(cleanSessionLine(`Well, ${line}`)).toBe(`Well, ${`${tenWords} `.repeat(19).trim()}`);
	});

	it('250 words with no sentence end → the first 200 and "…"', () => {
		const words = Array.from({ length: 250 }, (_, index) => `w${index}`);

		expect(cleanSessionLine(words.join(' '))).toBe(`${words.slice(0, 200).join(' ')}…`);
	});
});
