import { describe, expect, it } from 'bun:test';
import {
	decideVersionFix,
	planVersionFix,
	readRemoteVersion,
	readUpdateOutcome,
	type UpdateOutcome,
} from './versions.js';

// Word for word what every released remote says when it refuses a main of another version.
const RELEASED_REFUSAL =
	'This machine runs Voice OS 5.0.1 and the main 5.1.0: run crew update on the older one, then crew server remote there.';

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
		// A remote left on a dev build (after a dev push) gets the main's release.
		['5.1.0', 'dev', 'update-remote'],
		['dev-abc1234', '5.0.1', 'none'],
		['v6.1.0', 'dev-a37d779', 'update-remote'],
		['5.1.0', null, 'none'],
	] as const)('main %s, remote %p → %s', (main, remote, fix) =>
		expect(decideVersionFix(main, remote)).toBe(fix),
	);
});

describe('planVersionFix', () => {
	const plan = (main: string, remote: string | null, tried?: UpdateOutcome) =>
		planVersionFix({
			main,
			remote,
			name: 'Build box',
			detail: RELEASED_REFUSAL,
			tried,
		});

	it('behind and not yet updated → update it', () => {
		expect(plan('5.1.0', '5.0.1')).toEqual({ kind: 'update', from: '5.0.1' });
	});

	it('behind and updated this run, still refused → never updated again, told to restart it there', () => {
		expect(plan('5.1.0', '5.0.1', { ok: true })).toEqual({
			kind: 'wait',
			status: 'error',
			detail: 'Build box is updated but still runs its old release: run crew server remote there.',
		});
	});

	it('behind and the update failed this run → the failure stays on the card', () => {
		expect(plan('5.1.0', '5.0.1', { ok: false, reason: 'Could not update Build box: x.' })).toEqual(
			{
				kind: 'wait',
				status: 'error',
				detail: 'Could not update Build box: x.',
			},
		);
	});

	it('newer than the main → update this machine, nothing installed there', () => {
		expect(plan('5.1.0', '5.2.0')).toEqual({
			kind: 'wait',
			status: 'error',
			detail:
				'Build box runs Voice OS 5.2.0, newer than this one (5.1.0): run crew update here, then crew server restart.',
		});
	});

	it('a remote on a dev build, under a released main → updated, once per version it ran', () => {
		expect(plan('v6.1.0', 'dev-a37d779')).toEqual({ kind: 'update', from: 'dev-a37d779' });
	});

	it("a main on a dev build, or no version to read → the remote's own words", () => {
		for (const [main, remote] of [
			['dev', '5.0.1'],
			['5.1.0', null],
		] as const) {
			expect(plan(main, remote)).toEqual({
				kind: 'wait',
				status: 'error',
				detail: RELEASED_REFUSAL,
			});
		}
	});
});

describe('readUpdateOutcome', () => {
	const read = (code: number | null, output: string, isTimedOut = false) =>
		readUpdateOutcome({ name: 'Build box', code, output, isTimedOut });

	it('exit 0 → updated', () => {
		expect(read(0, 'Updating crew v5.0.1 → v5.1.0\ncrew updated to v5.1.0\n')).toEqual({
			ok: true,
		});
	});

	it("exit 0 but Voice OS was not updated → a failure, in crew's own words", () => {
		expect(
			read(0, 'crew updated to v5.1.0\n! Voice OS was not updated: download failed: 404.\n'),
		).toEqual({
			ok: false,
			reason:
				'Could not update Build box: Voice OS was not updated: download failed: 404. Run crew update there, then crew server remote.',
		});
	});

	it('a failure → its last line; nothing printed → the exit code; too slow → said so', () => {
		expect(read(1, 'Downloading…\nError: disk full\n')).toMatchObject({
			reason:
				'Could not update Build box: Error: disk full. Run crew update there, then crew server remote.',
		});
		expect(read(255, '')).toMatchObject({
			reason:
				'Could not update Build box: crew update exited 255. Run crew update there, then crew server remote.',
		});
		expect(read(null, 'Downloading…', true)).toMatchObject({
			reason:
				'Could not update Build box: crew update did not finish in time. Run crew update there, then crew server remote.',
		});
	});
});
