import { describe, expect, it } from 'bun:test';
import { resolveClaudeBin, isCompiled } from './claude-bin.js';

const which = (found: string | null) => () => found;

describe('resolveClaudeBin', () => {
	it('override wins everywhere', () =>
		expect(resolveClaudeBin({ override: '/x/claude', compiled: true, which: which('/y') })).toBe(
			'/x/claude',
		));
	it('from source → undefined, the SDK uses its pinned copy', () =>
		expect(
			resolveClaudeBin({ override: undefined, compiled: false, which: which('/y') }),
		).toBeUndefined());
	it('compiled → claude on PATH', () =>
		expect(
			resolveClaudeBin({
				override: undefined,
				compiled: true,
				which: which('/usr/local/bin/claude'),
			}),
		).toBe('/usr/local/bin/claude'));
	it('compiled, none on PATH → null', () =>
		expect(
			resolveClaudeBin({ override: undefined, compiled: true, which: which(null) }),
		).toBeNull());
});

describe('isCompiled', () => {
	it('bunfs entry → compiled', () => expect(isCompiled('/$bunfs/root/voiceos')).toBe(true));
	it('source entry → not compiled', () =>
		expect(isCompiled('/Users/x/voiceos/src/main.ts')).toBe(false));
});
