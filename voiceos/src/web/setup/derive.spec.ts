import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	describeCheckAction,
	listWorkspacesOf,
	deriveFirstRun,
	deriveProjectState,
	describeIssue,
	describeStages,
	listProblems,
	readCheck,
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
	it('a failed check, a broken worktree, then one quiet row for what is not set up', () => {
		const problems = listProblems(PROJECTS, WORKTREES);

		expect(problems.map((problem) => [problem.name, problem.isQuiet, problem.fix])).toEqual([
			['store-front/wrk1', false, { page: 'worktree', ref: 'store-front/wrk1' }],
			['store-api', false, { page: 'project', name: 'store-api' }],
			['signals', true, { page: 'project-edit', name: 'signals' }],
		]);
		expect(problems[0]?.what).toBe('store-api install failed · ERR_PNPM_NO_MATCHING_VERSION');
	});

	it('several not set up → one row with Set up with Claude for all of them', () => {
		const bare = PROJECTS.map((project) => ({ ...project, dev_servers: [] }));
		const quiet = listProblems(bare, []).at(-1);

		expect(quiet?.name).toBe('3 projects not set up');
		expect(quiet?.fix).toBeNull();
		expect(quiet?.ask).toContain('store-front, store-api, signals');
	});

	it('a project is failed by its kept check, set up by its servers', () => {
		const state = (name: string) =>
			deriveProjectState(
				PROJECTS.find((project) => project.name === name) as CrewProject,
				WORKTREES,
			);

		expect([state('store-front'), state('store-api'), state('signals')]).toEqual([
			'ready',
			'failed',
			'setup',
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
