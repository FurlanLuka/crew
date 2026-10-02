import { describe, expect, it } from 'bun:test';
import type { StreamItem } from '../../shared/protocol.js';
import { describeRecorded, listRecordedLines, splitCommandLine } from './recorded.js';

describe('"✓ recorded" lines', () => {
	it('splitCommandLine keeps quoted words together', () =>
		expect(
			splitCommandLine(`crew dev add signals --name=web --cmd="pnpm dev" --port=5173`),
		).toEqual(['crew', 'dev', 'add', 'signals', '--name=web', '--cmd=pnpm dev', '--port=5173']));

	it.each([
		['run crew add project payments https://github.com/acme/payments.git', 'Added payments'],
		['run crew add project signals --setup="pnpm install"', 'Install: pnpm install'],
		['run crew dev add signals --name=dashboard --port=5173', 'Dev server: dashboard :5173'],
		['run crew dev add signals --name=worker', "Dev server: worker (no port, it doesn't listen)"],
		['run crew dev add signals --name=api --rename=server', 'Renamed dev server server → api'],
		[
			'run crew dev add signals --name=api --rename=api --port=0',
			"Dev server: api (no port, it doesn't listen)",
		],
		[
			"run crew add binding signals --var=DATABASE_URL --value='postgres://u:secret@db/x'",
			'Environment: DATABASE_URL',
		],
		[
			'run crew add binding signals/worker --var=REDIS_URL --value=x',
			'Environment: REDIS_URL (worker only)',
		],
		['run crew add workspace payments payments', 'Workspace: payments (payments)'],
		[
			'run crew add override store-front/main store-front.STRIPE_KEY=sk_test',
			'Pinned value: STRIPE_KEY in store-front/main',
		],
		['run crew server machines add dev@gpu-box --name=gpu', 'Machine: gpu (dev@gpu-box)'],
		['run crew ls projects --json', null],
		['run bun test', null],
	])('%s → %p', (command, line) => expect(describeRecorded(command)).toBe(line));

	it('a value is never said: only its name', () =>
		expect(
			describeRecorded("run crew add binding signals --var=TOKEN --value='hunter2'"),
		).not.toContain('hunter2'));

	it('only a crew call that succeeded records anything', () => {
		const stream: StreamItem[] = [
			{
				id: 't1',
				at: 1,
				kind: 'tool',
				name: 'Bash',
				summary: 'run crew dev add signals --name=web --port=3000',
			},
			{ id: 'r1', at: 2, kind: 'tool_result', ok: true, summary: 'Added dev server' },
			{
				id: 't2',
				at: 3,
				kind: 'tool',
				name: 'Bash',
				summary: 'run crew dev add signals --name=api --port=3001',
			},
			{ id: 'r2', at: 4, kind: 'tool_result', ok: false, summary: 'Error: no project' },
			{ id: 't3', at: 5, kind: 'text', text: 'I recorded everything.' },
		];

		expect(listRecordedLines(stream)).toEqual([{ afterId: 't1', text: 'Dev server: web :3000' }]);
	});
});
