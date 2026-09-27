import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	CrewAdapter,
	parseProjects,
	parseWorktrees,
	toWorktreeInfo,
	type CrewRunResult,
	type CrewRunner,
} from './adapter.js';
import { configureLog } from '../log.js';

configureLog({ quiet: true });

const readGolden = (name: string) => {
	// Golden files come from crew's own Go tests (cmd_voice_test.go), so `crew … --json` cannot drift.
	return readFileSync(join(import.meta.dir, '..', '..', 'testdata', name), 'utf8');
};

describe('parseWorktrees', () => {
	it('golden crew ls worktrees --json → rows, checks excluded', () => {
		const rows = parseWorktrees(readGolden('ls-worktrees.json'));

		expect(rows.map((row) => row.ref)).toEqual(['store-front/main', 'store-front/wrk1']);
	});

	it('not an array → throws a clear error', () =>
		expect(() => parseWorktrees('{}')).toThrow('expected a JSON array'));
});

describe('toWorktreeInfo', () => {
	const row = {
		ref: 'store-front/main',
		path: '/w/store-front/main',
		dev_running: false,
		installing: false,
	};

	it('several projects → root cwd, every checkout added', () => {
		const projects = parseProjects(readGolden('show-worktree.json'));

		expect(toWorktreeInfo({ row, projects, branch: 'b' })).toEqual({
			ref: 'store-front/main',
			label: 'store-front/main',
			branch: 'b',
			cwd: '/w/store-front/main',
			dirs: projects.map((project) => project.path),
			isPinned: false,
		});
	});

	it('one project → cwd is its checkout, no extra dirs', () => {
		const info = toWorktreeInfo({
			row,
			projects: [{ name: 'store-api', path: '/w/x/store-api', mode: 'worktree' }],
			branch: '',
		});

		expect(info).toMatchObject({ cwd: '/w/x/store-api', dirs: [] });
	});
});

describe('CrewAdapter', () => {
	const show = JSON.stringify([
		{ name: 'store-api', path: '/w/store-front/main/store-api', mode: 'worktree' },
	]);

	const createAdapter = (respond: (args: string[]) => CrewRunResult) => {
		const calls: string[][] = [];

		const run: CrewRunner = async (args) => {
			calls.push(args);

			return respond(args);
		};

		return { crew: new CrewAdapter(run, async (path) => `branch-of:${path}`), calls };
	};

	it('asks crew for --json and resolves each worktree with its branch', async () => {
		const { crew, calls } = createAdapter((args) => ({
			code: 0,
			stdout: args[0] === 'ls' ? readGolden('ls-worktrees.json') : show,
			stderr: '',
		}));
		const infos = await crew.listWorktrees();

		expect(calls[0]).toEqual(['ls', 'worktrees', '--json']);
		expect(calls.slice(1).every((call) => call[0] === 'show' && call.at(-1) === '--json')).toBe(
			true,
		);
		expect(infos.map((info) => [info.ref, info.branch])).toEqual([
			['store-front/main', 'branch-of:/w/store-front/main/store-api'],
			['store-front/wrk1', 'branch-of:/w/store-front/main/store-api'],
		]);
	});

	it('one worktree failing → left out, the others still list', async () => {
		const { crew } = createAdapter((args) => {
			if (args[0] === 'ls') {
				return { code: 0, stdout: readGolden('ls-worktrees.json'), stderr: '' };
			}

			if (args[1] === 'store-front/wrk1') {
				return { code: 1, stdout: '', stderr: 'broken checkout' };
			}

			return { code: 0, stdout: show, stderr: '' };
		});

		expect((await crew.listWorktrees()).map((info) => info.ref)).toEqual(['store-front/main']);
	});

	it('crew failing outright → error carries its stderr', async () => {
		const { crew } = createAdapter(() => ({ code: 2, stdout: '', stderr: 'no config' }));

		await expect(crew.listWorktrees()).rejects.toThrow('no config');
	});

	it('orientation → the text crew start prints', async () => {
		const { crew, calls } = createAdapter(() => ({
			code: 0,
			stdout: 'You are working in store-front/main.',
			stderr: '',
		}));

		expect(await crew.fetchOrientation('store-front/main')).toBe(
			'You are working in store-front/main.',
		);
		expect(calls[0]).toEqual(['start', 'store-front/main']);
	});
});
