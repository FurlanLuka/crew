import { describe, expect, it } from 'bun:test';
import {
	describeContextLevel,
	describeContextTitle,
	formatContextUsage,
	formatTokens,
} from './context-meter.js';

describe('formatTokens', () => {
	it.each([
		[950, '950'],
		[41_600, '42k'],
		[200_000, '200k'],
		[999_600, '1M'],
		[1_000_000, '1M'],
		[1_240_000, '1.2M'],
	])('%d → %s', (tokens, text) => expect(formatTokens(tokens)).toBe(text));
});

describe('the meter', () => {
	it('used of the window, short; the title says it exactly, and where it compacts', () => {
		expect(formatContextUsage({ used: 41_600, max: 200_000 })).toBe('42k / 200k');
		expect(describeContextTitle({ used: 41_600, max: 200_000, compactAt: 167_000 })).toBe(
			'Context: 41,600 of 200,000 tokens (21%); Claude Code compacts on its own at 167k',
		);
		expect(describeContextTitle({ used: 41_600, max: 200_000 })).toBe(
			'Context: 41,600 of 200,000 tokens (21%)',
		);
	});

	it.each([
		[133_000, 'ok'],
		[134_000, 'high'],
		[158_000, 'high'],
		[159_000, 'full'],
		[230_000, 'full'],
	] as const)('%d with compaction at 167k → %s', (used, level) =>
		expect(describeContextLevel({ used, max: 200_000, compactAt: 167_000 })).toBe(level),
	);

	it('no compaction point → measured against the window', () => {
		expect(describeContextLevel({ used: 159_000, max: 200_000 })).toBe('ok');
		expect(describeContextLevel({ used: 160_000, max: 200_000 })).toBe('high');
	});

	it('no window reported → never alarming', () =>
		expect(describeContextLevel({ used: 5000, max: 0 })).toBe('ok'));
});
