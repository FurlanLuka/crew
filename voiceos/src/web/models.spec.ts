import { describe, expect, it } from 'bun:test';
import { describeModel, describeSessionModel, isCurrentChoice } from './models.js';

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
});

describe('describeSessionModel', () => {
	it('the 1M window from the context reading, once; none read yet → the id alone', () => {
		expect(describeSessionModel('claude-opus-5-5', 1_000_000)).toBe('Opus 5.5 · 1M');
		expect(describeSessionModel('claude-opus-5-5[1m]', 1_000_000)).toBe('Opus 5.5 · 1M');
		expect(describeSessionModel('claude-sonnet-5-5', 200_000)).toBe('Sonnet 5.5');
		expect(describeSessionModel('claude-opus-5-5', null)).toBe('Opus 5.5');
		expect(describeSessionModel('claude-opus-5-5', 999_999)).toBe('Opus 5.5');
	});
});

describe('isCurrentChoice', () => {
	it('the reported id with its window from the reading; a dated id is the same model', () => {
		expect(isCurrentChoice('claude-opus-5-5[1m]', 'claude-opus-5-5', 1_000_000)).toBe(true);
		expect(isCurrentChoice('claude-opus-5-5[1m]', 'claude-opus-5-5', 200_000)).toBe(false);
		expect(isCurrentChoice('claude-haiku-5-5', 'claude-haiku-5-5-20260901', 200_000)).toBe(true);
		expect(isCurrentChoice('claude-sonnet-5-5', 'claude-opus-5-5', 200_000)).toBe(false);
	});
});
