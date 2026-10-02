import { describe, expect, it } from 'bun:test';
import { readGolden } from '../../../test/support/fake-crew.js';
import type { CrewProject } from './types.js';
import { listWires, planWorkspace } from './workspace.js';

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
