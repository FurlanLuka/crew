import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	countNeedsYou,
	describeCheckAction,
	describeServer,
	describeSetupMeta,
	hasDevServers,
	listWorkspacesOf,
	deriveFirstRun,
	deriveProjectState,
	describeIssue,
	describeStages,
	listProblems,
	readCheck,
	summarizeList,
} from './derive.js';
import type { CrewCheckStatus, CrewProject, CrewWorkspace, CrewWorktree } from './types.js';

// The shapes crew's own tests write: what the page reads is what crew prints.
const golden = <T>(name: string): T =>
	JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'testdata', name), 'utf8')) as T;

const PROJECTS = golden<CrewProject[]>('ls-projects.json');
const WORKTREES = golden<CrewWorktree[]>('ls-worktrees-setup.json');

describe('deriveFirstRun', () => {
	it('no projects → empty', () => expect(deriveFirstRun([], [])).toBe('empty'));
	it('projects, no worktree (a kept check is not one) → has-projects', () =>
		expect(
			deriveFirstRun(
				PROJECTS,
				WORKTREES.filter((row) => row.ref.startsWith('check/')),
			),
		).toBe('has-projects'));
	it('a worktree → ready', () => expect(deriveFirstRun(PROJECTS, WORKTREES)).toBe('ready'));
	it('not read yet → ready (nothing greyed while crew answers)', () =>
		expect(deriveFirstRun(null, null)).toBe('ready'));
});

describe('the board from crew goldens', () => {
	it('a broken worktree and a failed check, nothing else (signals has no dev servers: no row)', () => {
		const problems = listProblems(WORKTREES);

		expect(problems.map((problem) => [problem.name, problem.fix])).toEqual([
			['store-front/wrk1', { page: 'worktree', ref: 'store-front/wrk1' }],
			['store-api', { page: 'project', name: 'store-api' }],
		]);
		expect(problems[0]?.what).toBe('store-api install failed · ERR_PNPM_NO_MATCHING_VERSION');
	});

	it('no failures → no problems and nothing needs you, whatever the projects have', () => {
		const healthy = WORKTREES.filter((row) => !row.issues?.length);

		expect(listProblems(healthy)).toEqual([]);
		expect(countNeedsYou(healthy)).toBe(0);
		expect(countNeedsYou(WORKTREES)).toBe(2);
	});

	it('a project is failed by its kept check, ready otherwise: no dev servers is ready', () => {
		const state = (name: string) =>
			deriveProjectState(
				PROJECTS.find((project) => project.name === name) as CrewProject,
				WORKTREES,
			);

		expect([state('store-front'), state('store-api'), state('signals')]).toEqual([
			'ready',
			'failed',
			'ready',
		]);
	});

	it('a server that never answered says so', () =>
		expect(
			describeIssue({
				stage: 'smoke',
				project: 'store-front',
				server: 'web',
				reason: 'not listening',
				detail: 'ready on :3000',
			}),
		).toBe('web is not listening · ready on :3000'));

	it('under a line that already names the project, the project is not said twice', () => {
		const issue = { stage: 'install', project: 'checkout-api', detail: 'ERR_PNPM' } as const;

		expect(describeIssue(issue)).toBe('checkout-api install failed · ERR_PNPM');
		expect(describeIssue(issue, { isNamed: false })).toBe('install failed · ERR_PNPM');
	});
});

describe('hasDevServers', () => {
	const member = (name: string) => ({ name, path: `/w/${name}`, mode: 'worktree' });

	it('a member with a dev server → true; only server-less members (signals) → false', () => {
		expect(hasDevServers([member('signals'), member('store-front')], PROJECTS)).toBe(true);
		expect(hasDevServers([member('signals')], PROJECTS)).toBe(false);
		expect(hasDevServers([], PROJECTS)).toBe(false);
	});
});

describe('describeStages', () => {
	it('a failed install → checkout passed, install failed, servers never tried', () => {
		expect(describeStages('install')).toEqual([
			{ name: 'checkout', status: 'ok' },
			{ name: 'install', status: 'bad' },
			{ name: 'servers', status: 'skip' },
		]);
	});
});

describe('readCheck (crew check project --status goldens)', () => {
	it('passed → ready, with when', () => {
		expect(readCheck(golden<CrewCheckStatus>('check-status-passed.json'), 'store-api', [])).toEqual(
			{
				state: 'passed',
				failure: null,
				at: '2026-10-02T09:30:00Z',
			},
		);
	});

	it('failed → the install failure crew recorded', () => {
		const view = readCheck(golden<CrewCheckStatus>('check-status-failed.json'), 'store-api', []);

		expect(view.state).toBe('failed');
		expect(view.failure?.stage).toBe('install');
		expect(view.failure?.detail).toContain('ERR_PNPM_NO_MATCHING_VERSION');
	});

	it('never checked → none; a kept failed check/<p> target still says failed', () => {
		const none = golden<CrewCheckStatus>('check-status-none.json');

		expect(readCheck(none, 'signals', [])).toEqual({ state: 'none', failure: null, at: null });
		expect(readCheck(none, 'store-api', WORKTREES).state).toBe(
			WORKTREES.some((row) => row.ref === 'check/store-api' && row.issues?.length)
				? 'failed'
				: 'none',
		);
	});
});

describe('describeCheckAction', () => {
	it.each([
		['none', 'Check'],
		['passed', 'Check again'],
		['failed', 'Check again'],
		['running', 'Check again'],
	] as const)('%s → %s', (state, want) => {
		expect(describeCheckAction(state)).toBe(want);
	});
});

describe('listWorkspacesOf', () => {
	const workspaces = [
		{ name: 'store-front', projects: [{ name: 'store-api', mode: 'worktree' }] },
		{ name: 'admin', projects: [{ name: 'admin', mode: 'worktree' }] },
	] as unknown as CrewWorkspace[];

	it('the workspaces a project is a member of; none for one in no workspace', () => {
		expect(listWorkspacesOf(workspaces, 'store-api').map((workspace) => workspace.name)).toEqual([
			'store-front',
		]);
		expect(listWorkspacesOf(workspaces, 'signals')).toEqual([]);
	});
});

describe('summarizeList', () => {
	it.each([
		[[], 2, ''],
		[['web'], 2, 'web'],
		[['web', 'api'], 2, 'web · api'],
		[['web', 'api', 'worker'], 2, 'web · api +1'],
		[['web', 'api', 'worker', 'cron'], 2, 'web · api +2'],
	])('%j, %i shown → %p', (items, shown, text) => {
		expect(summarizeList(items, shown)).toBe(text);
		expect(summarizeList(items, shown)).not.toContain('+0');
	});
});

describe('describeServer', () => {
	it.each([
		[{ name: 'web', port: 3000 }, 'web :3000'],
		[{ name: 'web', port: 0 }, 'web'],
		[{ name: 'web' }, 'web'],
	])('%j → %p', (server, text) => expect(describeServer(server)).toBe(text));
});

describe("Home's Set up meta", () => {
	it('projects without dev servers are just projects; only failures need you', () => {
		const bare: CrewProject[] = [
			{ name: 'store-front', path: '/code/store-front', remote: '' },
			{ name: 'infra-ops', path: '/code/infra-ops', remote: '' },
		];

		expect(describeSetupMeta(bare, [])).toBe('2 projects on This Mac');
		expect(
			describeSetupMeta(bare, [
				{
					ref: 'admin/main',
					path: '/w',
					dev_running: false,
					installing: false,
					issues: [{ stage: 'install', project: 'admin', detail: 'ERR' }],
				},
			]),
		).toBe('1 thing needs you');
	});
});
