import { describe, expect, it } from 'bun:test';
import { FOCUSED_WORDS, isFormatOk, NARRATION_WORDS } from './narrator.js';

describe('isFormatOk', () => {
	const ok = (spoken: string, extra: { maxWords?: number; notIncludes?: string[] } = {}) =>
		isFormatOk({ spoken, label: 'store-front/main', speak: true, ...extra });

	it('narration past its word limit fails', () => {
		expect(ok('word '.repeat(NARRATION_WORDS).trim())).toBe(true);
		expect(ok('word '.repeat(NARRATION_WORDS + 1).trim())).toBe(false);
		expect(ok('word '.repeat(FOCUSED_WORDS + 1).trim(), { maxWords: FOCUSED_WORDS })).toBe(false);
	});

	it('an option read out when only the question should be → fails', () => {
		expect(
			ok('asks: which one do you want? Say options to hear them.', {
				notIncludes: ['idempotency'],
			}),
		).toBe(true);
		expect(
			ok('asks: idempotency table, constraint or memory?', { notIncludes: ['idempotency'] }),
		).toBe(false);
	});
});
