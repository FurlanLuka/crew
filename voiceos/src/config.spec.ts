import { describe, expect, it } from 'bun:test';
import { CLAUDE_MISSING, missingFor, resolvePaths, shouldRecordState } from './config.js';

describe('shouldRecordState', () => {
	it('launched by crew → records', () =>
		expect(shouldRecordState({ VOICEOS_RECORD_STATE: '1', PORT: '4000' })).toBe(true));
	it('manual run, even with a PORT → does not record', () =>
		expect(shouldRecordState({ PORT: '4000' })).toBe(false));
	it('flag set to anything else → does not record', () =>
		expect(shouldRecordState({ VOICEOS_RECORD_STATE: 'yes' })).toBe(false));
});

describe('missingFor', () => {
	const paths = resolvePaths({ HOME: '/h', VOICEOS_KEYS_DIR: '/h/keys' });

	it('no keys, no claude → both key files and claude', () => {
		expect(missingFor({ keys: { anthropic: null, soniox: null }, paths, claudeBin: null })).toEqual(
			['/h/keys/anthropic.key', '/h/keys/soniox.key', CLAUDE_MISSING],
		);
	});

	it('keys set while claude is still missing → the key entries clear, the claude entry stays', () => {
		expect(
			missingFor({ keys: { anthropic: 'sk-ant', soniox: 'sk-son' }, paths, claudeBin: null }),
		).toEqual([CLAUDE_MISSING]);
	});

	it('everything there → nothing', () => {
		expect(
			missingFor({
				keys: { anthropic: 'sk-ant', soniox: 'sk-son' },
				paths,
				claudeBin: '/bin/claude',
			}),
		).toEqual([]);
	});

	it("from source (undefined: the SDK's own claude) → claude is not missing", () => {
		expect(
			missingFor({ keys: { anthropic: 'sk-ant', soniox: 'sk-son' }, paths, claudeBin: undefined }),
		).toEqual([]);
	});

	it('one key → only the other', () => {
		expect(
			missingFor({ keys: { anthropic: 'sk-ant', soniox: null }, paths, claudeBin: '/bin/claude' }),
		).toEqual(['/h/keys/soniox.key']);
	});
});
