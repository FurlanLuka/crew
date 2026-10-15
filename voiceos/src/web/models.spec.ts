import { describe, expect, it } from 'bun:test';
import { describeModel, isSameModel } from './models.js';

describe('describeModel', () => {
	it.each([
		['claude-opus-5-5[1m]', 'Opus 5.5 · 1M'],
		['claude-opus-5-5', 'Opus 5.5'],
		['claude-sonnet-5-5', 'Sonnet 5.5'],
		['claude-haiku-5-5-20260901', 'Haiku 5.5'],
		['claude-fable-5-1', 'Fable 5.1'],
		['opus', 'Opus'],
		['some-proxy/model:v2', 'some-proxy/model:v2'],
	])('%s → %s', (id, said) => expect(describeModel(id)).toBe(said));

	it('a dated id is the same pick as the plain one; 1M is not', () => {
		expect(isSameModel('claude-haiku-5-5-20260901', 'claude-haiku-5-5')).toBe(true);
		expect(isSameModel('claude-opus-5-5', 'claude-opus-5-5[1m]')).toBe(false);
	});
});
