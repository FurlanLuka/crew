import { describe, expect, it } from 'bun:test';
import { readGolden } from '../../../test/support/fake-crew.js';
import { listSources, planProjectSave, toRow } from './project-form.js';
import type { CrewProject } from './types.js';

const PROJECTS = readGolden<CrewProject[]>('ls-projects.json');
const API = PROJECTS.find((project) => project.name === 'store-api') as CrewProject;
const ROWS = (API.dev_servers ?? []).map(toRow);

describe('planProjectSave', () => {
	it('nothing changed → nothing to run', () => {
		expect(
			planProjectSave({ project: API, setup: '', envCmd: 'make env', rows: ROWS, binding: null }),
		).toEqual([]);
	});

	it('install, a renamed server, a removed one and a binding → in that order', () => {
		const [api] = ROWS;
		const rows = api ? [{ ...api, name: 'http', port: '4100' }] : [];

		expect(
			planProjectSave({
				project: API,
				setup: 'pnpm install',
				envCmd: 'make env',
				rows,
				binding: { var: 'LOG_LEVEL', value: 'debug', server: 'http' },
			}),
		).toEqual([
			{ type: 'update_project', name: 'store-api', setup: 'pnpm install' },
			{
				type: 'dev_add',
				project: 'store-api',
				name: 'http',
				cmd: 'make dev',
				rename: 'api',
				port: 4100,
			},
			{ type: 'dev_rm', project: 'store-api', server: 'worker' },
			{
				type: 'add_binding',
				project: 'store-api',
				var: 'LOG_LEVEL',
				value: 'debug',
				server: 'http',
			},
		]);
	});

	it('a new row without a command, or a binding without a value → left out', () => {
		const added = { key: 9, original: null, name: 'cron', command: ' ', dir: '', port: '' };

		expect(
			planProjectSave({
				project: API,
				setup: '',
				envCmd: 'make env',
				rows: [...ROWS, added],
				binding: { var: 'X', value: '', server: '' },
			}),
		).toEqual([]);
	});

	it('a new server keeps its dir and leaves out a port that is not a number', () => {
		const added = {
			key: 9,
			original: null,
			name: 'cron',
			command: 'make cron',
			dir: 'jobs',
			port: 'x',
		};

		expect(
			planProjectSave({
				project: API,
				setup: '',
				envCmd: 'make env',
				rows: [...ROWS, added],
				binding: null,
			}),
		).toEqual([
			{ type: 'dev_add', project: 'store-api', name: 'cron', cmd: 'make cron', dir: 'jobs' },
		]);
	});
});

describe('planProjectSave, a cleared port', () => {
	it('a renamed row whose port was cleared → --port=0, the server no longer listens', () => {
		const [api, worker] = ROWS;
		const rows = api && worker ? [{ ...api, name: 'http', port: '' }, worker] : [];

		expect(
			planProjectSave({ project: API, setup: '', envCmd: 'make env', rows, binding: null }),
		).toEqual([
			{
				type: 'dev_add',
				project: 'store-api',
				name: 'http',
				cmd: 'make dev',
				rename: 'api',
				port: 0,
			},
		]);
	});

	it('a renamed row whose dir was cleared → --dir= sent empty, the old dir is not kept', () => {
		const [api, worker] = ROWS;
		const rows = api && worker ? [api, { ...worker, name: 'jobs', dir: '' }] : [];

		expect(
			planProjectSave({ project: API, setup: '', envCmd: 'make env', rows, binding: null }),
		).toEqual([
			{
				type: 'dev_add',
				project: 'store-api',
				name: 'jobs',
				cmd: 'make worker',
				rename: 'worker',
				dir: '',
			},
		]);
	});

	it('a server that never had a port → no port sent', () => {
		const [api, worker] = ROWS;
		const rows = api && worker ? [api, { ...worker, command: 'make jobs' }] : [];

		expect(
			planProjectSave({ project: API, setup: '', envCmd: 'make env', rows, binding: null }),
		).toEqual([
			{ type: 'dev_add', project: 'store-api', name: 'worker', cmd: 'make jobs', dir: 'worker' },
		]);
	});
});

describe('listSources', () => {
	it("other projects' URLs and ports (per server when it has several), then names and a fixed value", () => {
		expect(listSources(PROJECTS, 'store-front').map((source) => source.value)).toEqual([
			'{{store-api}}',
			'{{store-api.port}}',
			'{{worktree}}',
			'{{workspace}}',
			'fixed',
		]);
		expect(listSources(PROJECTS, 'store-api').map((source) => source.label)).toEqual([
			"store-front's URL",
			"store-front's port",
			"the worktree's name",
			"the workspace's name",
			'a fixed value',
		]);
	});
});
