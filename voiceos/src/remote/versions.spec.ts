import { describe, expect, it } from 'bun:test';
import { decideVersionFix, readRemoteVersion } from './versions.js';

// Word for word what every released remote says when it refuses a main of another version.
const RELEASED_REFUSAL =
	'This machine runs Voice OS 5.0.1 and the main 5.1.0: run crew update on the older one, then crew voice remote there.';

describe('readRemoteVersion', () => {
	it("a released remote's refusal wording → its version", () => {
		expect(readRemoteVersion({ detail: RELEASED_REFUSAL })).toBe('5.0.1');
	});

	it('the version field, when the remote sends one, wins over the wording', () => {
		expect(readRemoteVersion({ version: '5.0.2', detail: RELEASED_REFUSAL })).toBe('5.0.2');
	});

	it('wording that names no version → null', () => {
		expect(readRemoteVersion({ detail: 'Another main holds this machine.' })).toBeNull();
	});
});

describe('decideVersionFix', () => {
	it.each([
		['5.1.0', '5.0.1', 'update-remote'],
		['5.10.0', '5.9.3', 'update-remote'],
		['5.1.0', '4.9.9', 'update-remote'],
		['5.1.0', '5.2.0', 'update-main'],
		['5.1.0', '5.1.0', 'none'],
		['dev', '5.0.1', 'none'],
		['5.1.0', 'dev', 'none'],
		['5.1.0', null, 'none'],
	] as const)('main %s, remote %p → %s', (main, remote, fix) =>
		expect(decideVersionFix(main, remote)).toBe(fix),
	);
});
