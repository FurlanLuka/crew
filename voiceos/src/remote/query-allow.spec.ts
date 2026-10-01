import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAllowedQuery, withSource } from './query-allow.js';

describe('isAllowedQuery', () => {
	it.each([
		// What crew sends: positionals first, --lines always, --json last when asked.
		[['voice', 'logs', '--lines=80'], true],
		[
			[
				'voice',
				'logs',
				'--since=2026-09-30T08:02:00Z',
				'--until=2026-09-30T09:00:00.5Z',
				'--cat=remote,main',
				'--level=warn',
				"--grep=it's $x; -y",
				'--lines=1000',
				'--machine=vm1,main',
				'--exclude=vm2',
				'--json',
			],
			true,
		],
		[['voice', 'debug-notes', '--since=2026-09-30T08:02:00Z', '--grep=x', '--lines=20'], true],
		[['voice', 'debug-notes', 'show', '3', '--around=1m30s', '--json'], true],
		[['voice', 'notes', 'store-front', '--since=2026-09-30T08:02:00Z', '--lines=20'], true],
		[['voice', 'notes', '--all', '--lines=20'], true],
		[['voice', 'notes', '--lines=20'], true],
		// Bounds and shapes.
		[['voice', 'logs', '--lines=1001'], false],
		[['voice', 'logs', '--lines=0'], false],
		[['voice', 'logs', '--lines=ten'], false],
		[['voice', 'logs', '--grep='], false],
		[['voice', 'logs', '--since', '10m'], false],
		[['voice', 'notes', '--all=yes'], false],
		// Never --local, --, unknown flags or extra words.
		[['voice', 'logs', '--local', '--json'], false],
		[['voice', 'logs', '--', '--json'], false],
		[['voice', 'logs', '--follow'], false],
		[['voice', 'logs', 'extra'], false],
		[['voice', 'notes', 'store-front', 'extra'], false],
		// A flag of another command.
		[['voice', 'notes', '--machine=vm1'], false],
		[['voice', 'logs', '--around=1m'], false],
		[['voice', 'debug-notes', '--around=1m'], false],
		[['voice', 'debug-notes', 'show', '3', '--lines=20'], false],
		[['voice', 'notes', '--until=2026-09-30T08:02:00Z'], false],
		// show only right after debug-notes, with one number.
		[['voice', 'debug-notes', '--grep=x', 'show', '3'], false],
		[['voice', 'logs', 'show', '3'], false],
		[['voice', 'debug-notes', 'show', 'abc'], false],
		[['voice', 'debug-notes', 'show'], false],
		[['voice', 'debug-notes', '3'], false],
		// Anything else.
		[['voice', 'start'], false],
		[['voice', 'debug-notes show'], false],
		[['dev', 'status', '--json'], false],
		[['voice'], false],
	])('%p → %p', (args, isAllowed) => {
		expect(isAllowedQuery(args as string[])).toBe(isAllowed);
	});
});

describe('a dev push from a remote', () => {
	it.each([
		[['voice', 'dev', 'targets', '--json']],
		[['voice', 'dev', 'status', '--json']],
		[['voice', 'dev', 'status']],
		[['voice', 'dev', '_handoff', 'dev-abc1234', '/home/dev/.crew/dev-push/dev-abc1234']],
		[
			[
				'voice',
				'dev',
				'_handoff',
				'dev-abc1234-dirty',
				'/home/dev/.crew/dev-push/dev-abc1234-dirty',
			],
		],
	])('%j → allowed', (args) => expect(isAllowedQuery(args)).toBe(true));

	it.each([
		[['voice', 'dev', 'push']],
		[['voice', 'dev', '_handoff', 'dev-abc1234', '/home/dev/x', '--source=vm1']],
		[['voice', 'dev', '_handoff', '5.8.0', '/home/dev/x']],
		[['voice', 'dev', '_handoff', 'dev-abc1234', 'relative/dir']],
		[['voice', 'dev', '_handoff', 'dev-abc1234', '/home/dev/../../etc']],
		[['voice', 'dev', '_handoff', 'dev-abc1234', '/home/dev/x; rm -rf ~']],
		[['voice', 'dev', 'targets', '--local']],
	])('%j → refused', (args) => expect(isAllowedQuery(args)).toBe(false));

	it('the main names the asking remote as the source itself; other queries pass as they came', () => {
		expect(withSource(['voice', 'dev', '_handoff', 'dev-abc', '/x'], 'vm1')).toEqual([
			'voice',
			'dev',
			'_handoff',
			'dev-abc',
			'/x',
			'--source=vm1',
		]);
		expect(withSource(['voice', 'dev', 'status'], 'vm1')).toEqual(['voice', 'dev', 'status']);
		expect(withSource(['voice', 'logs'], 'vm1')).toEqual(['voice', 'logs']);
	});
});

describe('the dev handoff, as crew checks it too', () => {
	const fixture = JSON.parse(
		readFileSync(join(import.meta.dir, '../../test/fixtures/shared/dev-handoff.json'), 'utf8'),
	) as { allowed: string[][]; refused: string[][] };

	it.each(fixture.allowed)('%s %s → allowed', (version, dir) =>
		expect(isAllowedQuery(['voice', 'dev', '_handoff', version ?? '', dir ?? ''])).toBe(true),
	);

	it.each(fixture.refused)('%s %s → refused', (version, dir) =>
		expect(isAllowedQuery(['voice', 'dev', '_handoff', version ?? '', dir ?? ''])).toBe(false),
	);
});
