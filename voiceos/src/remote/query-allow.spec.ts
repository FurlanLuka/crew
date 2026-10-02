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
		[['voice', 'dev', '_targets', '--json']],
		[['voice', 'dev', 'status', '--json']],
		[['voice', 'dev', 'status']],
	])('%j → allowed', (args) => expect(isAllowedQuery(args)).toBe(true));

	it.each([
		[['voice', 'dev', 'push']],
		[['voice', 'dev', 'targets', '--json']],
		[['voice', 'dev', '_handoff', 'dev-abc1234', '--source=vm1']],
		[['voice', 'dev', '_targets', '--local']],
	])('%j → refused', (args) => expect(isAllowedQuery(args)).toBe(false));

	it('the main names the asking remote as the source itself; other queries pass as they came', () => {
		expect(withSource(['voice', 'dev', '_handoff', 'dev-abc'], 'vm1')).toEqual([
			'voice',
			'dev',
			'_handoff',
			'dev-abc',
			'--source=vm1',
		]);
		expect(withSource(['voice', 'dev', 'status'], 'vm1')).toEqual(['voice', 'dev', 'status']);
		expect(withSource(['voice', 'logs'], 'vm1')).toEqual(['voice', 'logs']);
	});
});

describe('a Discord message from a remote', () => {
	const STAGE = '0123456789abcdef';

	it.each([
		[['voice', 'discord', '_send', STAGE]],
		[['voice', 'discord', '_send', STAGE, '--json']],
		[['voice', 'discord', 'status', '--json']],
		[['voice', 'discord', 'status']],
	])('%j → allowed', (args) => expect(isAllowedQuery(args)).toBe(true));

	it.each([
		[['voice', 'discord', '_send', STAGE, '--source=vm1']],
		[['voice', 'discord', '_send', '../../etc/passwd']],
		[['voice', 'discord', '_send', 'ABCDEF0123456789']],
		[['voice', 'discord', '_send']],
		[['voice', 'discord', 'send', '--text=hi']],
		[['voice', 'discord', 'setup', '--text-channel=1']],
		[['voice', 'discord', 'off']],
		[['voice', 'discord', 'channels', '--json']],
	])('%j → refused', (args) => expect(isAllowedQuery(args)).toBe(false));

	it("the main names the asking remote as the stage's source itself", () =>
		expect(withSource(['voice', 'discord', '_send', STAGE, '--json'], 'vm1')).toEqual([
			'voice',
			'discord',
			'_send',
			STAGE,
			'--json',
			'--source=vm1',
		]));
});

describe('the dev handoff, as crew checks it too', () => {
	const fixture = JSON.parse(
		readFileSync(join(import.meta.dir, '../../test/fixtures/shared/dev-handoff.json'), 'utf8'),
	) as { allowed: string[][]; refused: string[][] };

	it.each(fixture.allowed)('%j → allowed', (...args) =>
		expect(isAllowedQuery(['voice', 'dev', '_handoff', ...args])).toBe(true),
	);

	it.each(fixture.refused)('%j → refused', (...args) =>
		expect(isAllowedQuery(['voice', 'dev', '_handoff', ...args])).toBe(false),
	);
});
