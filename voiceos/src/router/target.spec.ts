import { describe, expect, it } from 'bun:test';
import { readTargetAnswer } from './target.js';

describe('readTargetAnswer', () => {
	it.each([
		['Yes.', 'yes'],
		['Yeah, go ahead.', 'yes'],
		['No.', 'no'],
		['Nope.', 'no'],
		['Here.', 'no'],
		['No, not that.', 'no'],
		['Actually, run the linter on the whole repo first.', 'other'],
		['Hmm.', 'other'],
	])('%p → %p', (utterance, answer) => expect(readTargetAnswer(utterance)).toBe(answer as never));
});
