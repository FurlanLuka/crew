import { describe, expect, it } from 'bun:test';
import type { SessionModel } from '../shared/protocol.js';
import { describeModel, describeSessionModel, findCurrentModel, readChipModel } from './models.js';

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

// As the Agent SDK 0.3.322 lists them, trimmed.
const LISTED: SessionModel[] = [
	{ id: 'default', resolved: 'claude-opus-5-5', name: 'Default (recommended)', description: '' },
	{ id: 'opus', resolved: 'claude-opus-5-5', name: 'Opus 5.5', description: '' },
	{ id: 'claude-fable-5-1', resolved: 'claude-fable-5-1', name: 'Fable 5.1', description: '' },
	{ id: 'sonnet', resolved: 'claude-sonnet-5-5', name: 'Sonnet 5.5', description: '' },
	{ id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', description: '' },
];

const currentOf = (model: string): string | null => findCurrentModel(LISTED, model)?.id ?? null;

describe('findCurrentModel', () => {
	it('a row picked by its own id → that row, "default" included', () => {
		expect(currentOf('opus')).toBe('opus');
		expect(currentOf('default')).toBe('default');
		expect(currentOf('claude-fable-5-1')).toBe('claude-fable-5-1');
	});

	it('the full id a start reports → the named row covering it, before "default"', () => {
		expect(currentOf('claude-opus-5-5')).toBe('opus');
		expect(currentOf('claude-sonnet-5-5')).toBe('sonnet');
	});

	it('a 1M or dated spelling of a listed model → its row', () => {
		expect(currentOf('claude-opus-5-5[1m]')).toBe('opus');
		expect(currentOf('claude-sonnet-5-5-20261001')).toBe('sonnet');
	});

	it('only "default" covers it → "default"', () => {
		expect(findCurrentModel([LISTED[0] as SessionModel], 'claude-opus-5-5')?.id).toBe('default');
	});

	it('a model the list does not have, or no list → none', () => {
		expect(currentOf('claude-opus-4-1')).toBeNull();
		expect(findCurrentModel([], 'claude-opus-5-5')).toBeNull();
	});
});

describe('readChipModel', () => {
	it('an alias from the list → the model it runs on; a full id or an unknown name → as it is', () => {
		expect(readChipModel(LISTED, 'opus')).toBe('claude-opus-5-5');
		expect(readChipModel(LISTED, 'default')).toBe('claude-opus-5-5');
		expect(readChipModel(LISTED, 'claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]');
		expect(readChipModel(LISTED, 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
		expect(readChipModel([], 'opus')).toBe('opus');
	});
});
