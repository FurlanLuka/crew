import { describe, expect, it } from 'bun:test';
import { judgeAlways } from '../../test/support/english-judge.js';
import type { Judge } from '../judge/judge.js';
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

	it('the session asked about is given to the judge: "checkout" alone can be a yes', async () => {
		const asked: (string | undefined)[] = [];

		const judge: Judge = async ({ context }) => {
			asked.push(context);

			return 'yes' as never;
		};

		expect(await readTargetAnswer(judge, 'Checkout.', 'checkout api, main')).toBe('yes');
		expect(asked).toEqual(['The session asked about: checkout api, main']);
	});
});
