import { describe, expect, it } from 'bun:test';
import { readGolden } from '../../../test/support/fake-crew.js';
import type { CrewProject, CrewWorktree } from './types.js';
import { listWires, listWorktreeCards, planWorkspace } from './workspace.js';

const PROJECTS = readGolden<CrewProject[]>('ls-projects.json');

describe('listWires', () => {
	it("the ticked projects' bindings to others, each saying whether its target is ticked", () => {
		expect(listWires(PROJECTS, ['store-front', 'store-api'])).toEqual([
			{ from: 'store-front', variable: 'STORE_API_URL', to: 'store-api', isTicked: true },
			{ from: 'store-front', variable: 'SIGNALS_URL', to: 'signals', isTicked: false },
		]);
	});

	it('a project not ticked → its bindings are not listed', () => {
		expect(listWires(PROJECTS, ['store-api'])).toEqual([]);
	});
});

describe('planWorkspace', () => {
	it('a new workspace → one add per mode', () => {
		expect(
			planWorkspace(
				'store',
				{ 'store-front': 'worktree', 'store-api': 'worktree', signals: 'direct' },
				[],
			),
		).toEqual([
			{ type: 'add_workspace', name: 'store', projects: ['store-front', 'store-api'] },
			{ type: 'add_workspace', name: 'store', projects: ['signals'], direct: true },
		]);
	});

	it('an empty new workspace → made with no projects', () => {
		expect(planWorkspace('store', {}, [])).toEqual([
			{ type: 'add_workspace', name: 'store', projects: [] },
		]);
	});

	it('an edit → only the projects not already members', () => {
		expect(
			planWorkspace('store', { 'store-front': 'worktree', signals: 'direct' }, ['store-front']),
		).toEqual([{ type: 'add_workspace', name: 'store', projects: ['signals'], direct: true }]);
	});

	it('no name → nothing', () => {
		expect(planWorkspace(' ', { signals: 'worktree' }, [])).toEqual([]);
	});
});

describe('listWorktreeCards', () => {
	const POOL: CrewProject[] = [
		{ name: 'store-front', remote: '', dev_servers: [{ name: 'web', command: 'pnpm dev' }] },
		{ name: 'store-api', remote: '', dev_servers: [{ name: 'api', command: 'pnpm dev' }] },
	];
	const row = (ref: string, patch: Partial<CrewWorktree> = {}): CrewWorktree => ({
		ref,
		path: `/w/${ref}`,
		dev_running: false,
		installing: false,
		...patch,
	});
	const cards = (rows: CrewWorktree[], sizes: CrewWorktree[] = []) =>
		listWorktreeCards({
			workspace: 'store',
			rows,
			sizes,
			members: ['store-front', 'store-api'],
			projects: POOL,
		});

	it("another workspace's worktrees are left out; the name is after the slash", () =>
		expect(cards([row('store/main'), row('store-2/main')]).map((card) => card.name)).toEqual([
			'main',
		]));

	it('running → every server up; stopped → every server stopped', () => {
		const [running, stopped] = cards([row('store/main', { dev_running: true }), row('store/wrk1')]);

		expect(running?.status).toBe('servers running');
		expect(running?.servers.map((pill) => `${pill.name}:${pill.state}`)).toEqual([
			'web:up',
			'api:up',
		]);
		expect(stopped?.servers.map((pill) => pill.state)).toEqual(['stopped', 'stopped']);
	});

	it('a server that died is the one named, the card says why', () => {
		const [card] = cards([
			row('store/wrk1', {
				dev_running: true,
				issues: [
					{ stage: 'smoke', project: 'store-api', server: 'api', reason: 'died', detail: 'boom' },
				],
			}),
		]);

		expect(card?.state).toBe('issue');
		expect(card?.status).toBe('api died · boom');
		expect(card?.servers.map((pill) => `${pill.name}:${pill.state}`)).toEqual([
			'web:up',
			'api:died',
		]);
	});

	it('sizes come from their own read, by ref: none yet, or a ref gone since → no size', () => {
		const [main, wrk1] = cards(
			[row('store/main'), row('store/wrk1')],
			[row('store/main', { size_bytes: 2048 }), row('store/gone', { size_bytes: 1 })],
		);

		expect(main?.sizeBytes).toBe(2048);
		expect(wrk1?.sizeBytes).toBeUndefined();
	});

	it('installing → its servers wait', () =>
		expect(
			cards([row('store/main', { installing: true })])[0]?.servers.map((pill) => pill.state),
		).toEqual(['wait', 'wait']));
});
