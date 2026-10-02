import { describe, expect, it } from 'bun:test';
import {
	cleanSessionLine,
	cleanSpokenText,
	cutAtSentence,
	endsInQuestion,
	INTERRUPT_PATTERN,
	normalizeUtterance,
	stripTags,
} from './spoken.js';

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

	it('250 words → cut at the last sentence end within 200 words, "More on screen."', () => {
		// 25 sentences of 10 words: the 20th ends on word 200.
		const tenWords = 'The parser handles nested quotes and escaped brackets correctly now.';
		const line = `${tenWords} `.repeat(25).trim();

		expect(cleanSessionLine(line)).toBe(`${`${tenWords} `.repeat(20)}More on screen.`);
		expect(cleanSessionLine(`Well, ${line}`)).toBe(
			`Well, ${`${tenWords} `.repeat(19)}More on screen.`,
		);
	});

	it('250 words with no sentence end → the first 200, "…" and "More on screen."', () => {
		const words = Array.from({ length: 250 }, (_, index) => `w${index}`);

		expect(cleanSessionLine(words.join(' '))).toBe(
			`${words.slice(0, 200).join(' ')}… More on screen.`,
		);
	});
});

describe('cutAtSentence', () => {
	const toWords = (text: string) => text.split(' ');

	it('within the cap → whole, nothing added', () =>
		expect(cutAtSentence(toWords('One two. Three four five.'), 5)).toBe(
			'One two. Three four five.',
		));

	it('a sentence end within the cap keeping half of it → cut there, "More on screen."', () =>
		expect(cutAtSentence(toWords('One two three. Four five six seven eight.'), 6)).toBe(
			'One two three. More on screen.',
		));

	it('the last end within the cap keeps under half → extended to the next end', () =>
		expect(cutAtSentence(toWords('One. Two three four five six seven. Eight nine.'), 6)).toBe(
			'One. Two three four five six seven. More on screen.',
		));

	it('extended to the very end → whole, nothing added', () =>
		expect(cutAtSentence(toWords('One. Two three four five six seven.'), 6)).toBe(
			'One. Two three four five six seven.',
		));

	it('a runaway with no end within twice the cap → cut at the cap, "…", "More on screen."', () =>
		expect(cutAtSentence(toWords('a b c d e f g h i j k l. m'), 4)).toBe(
			'a b c d… More on screen.',
		));

	it('"e.g." and "v2." are no sentence end; "?" and a closing quote are', () => {
		expect(cutAtSentence(toWords('Use a flag, e.g. verbose mode on every run here'), 6)).toBe(
			'Use a flag, e.g. verbose mode… More on screen.',
		);
		expect(cutAtSentence(toWords('We shipped v2. and then fixed the rest later on'), 6)).toBe(
			'We shipped v2. and then fixed… More on screen.',
		);
		expect(cutAtSentence(toWords('Should I push "main?" It has the fix in it'), 6)).toBe(
			'Should I push "main?" More on screen.',
		);
	});

	it('"e.g." behind an opening bracket or quote → no sentence end', () => {
		expect(cutAtSentence(toWords('Add a flag (e.g. verbose) on every run here'), 6)).toBe(
			'Add a flag (e.g. verbose) on… More on screen.',
		);
		expect(cutAtSentence(toWords('It said "e.g. staging" for every run here'), 6)).toBe(
			'It said "e.g. staging" for every… More on screen.',
		);
	});

	it('bare list numbers "1." "2." → no sentence end; the item\'s own period is', () =>
		expect(cutAtSentence(toWords('Do this: run tests. 2. Push the branch.'), 5)).toBe(
			'Do this: run tests. More on screen.',
		));

	it('cleanSpokenText cuts the same way at its word cap', () =>
		expect(cleanSpokenText('One two three. Four five six seven eight.', 6)).toBe(
			'One two three. More on screen.',
		));
});

describe('voice tags', () => {
	it('an allowed tag → kept for the voice, lowercased', () =>
		expect(cleanSpokenText('That is funny. [Laughs] Okay, pushing it.')).toBe(
			'That is funny. [laughs] Okay, pushing it.',
		));

	it('an unknown [x] and SSML → removed whole, never read aloud', () => {
		expect(cleanSpokenText('Done. [whispers] It passed.')).toBe('Done. It passed.');
		expect(cleanSpokenText('Done.<break time="1s"/> It passed.')).toBe('Done. It passed.');
		expect(cleanSpokenText('Use a < b > c here.')).toBe('Use a < b c here.');
	});

	it('a markdown link → its words', () =>
		expect(cleanSpokenText('See [the retry plan](https://claude.ai/x) first.')).toBe(
			'See the retry plan first.',
		));

	it('stripTags → the words alone', () => {
		expect(stripTags('That is funny. [laughs] Okay.')).toBe('That is funny. Okay.');
		expect(stripTags('[sighs] It failed again [pause].')).toBe('It failed again.');
		expect(stripTags('Keep [x] as it is.')).toBe('Keep [x] as it is.');
	});

	it('a question with a trailing tag → still a question', () => {
		expect(endsInQuestion('Should I push it? [curious]')).toBe(true);
		expect(endsInQuestion('Pushed. [relieved]')).toBe(false);
	});

	it('a question mark inside closing quotes → still a question', () => {
		expect(endsInQuestion('It asks "which one?"')).toBe(true);
		expect(endsInQuestion('It asks “which one?”')).toBe(true);
	});
});
