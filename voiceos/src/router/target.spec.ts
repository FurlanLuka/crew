import { describe, expect, it } from 'bun:test';
import { judgeAlways } from '../../test/support/english-judge.js';
import { readTargetAnswer } from './target.js';

describe('readTargetAnswer', () => {
	it.each([
		['yes', 'yes'],
		['no', 'no'],
		['other', 'other'],
		// A check that timed out or could not tell: new words, never a yes.
		['unclear', 'other'],
	])('the judge says %p → %p', async (verdict, answer) =>
		expect(await readTargetAnswer(judgeAlways(verdict), 'Ja, bitte.')).toBe(answer as never),
	);
});
