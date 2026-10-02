import { describe, expect, it } from 'bun:test';
import { readGolden } from '../../../test/support/fake-crew.js';
import { exportCommand, listExported, listLoose } from './export.js';
import type { CrewProject, CrewWorkspace } from './types.js';

// crew's goldens: workspaces store-front (store-front, store-api, signals) and admin (store-front).
const WORKSPACES = readGolden<CrewWorkspace[]>('ls-workspaces.json');
const NAMES = [
	...readGolden<CrewProject[]>('ls-projects.json').map((project) => project.name),
	'notes',
];

describe('what an export takes', () => {
	const loose = listLoose(NAMES, WORKSPACES);

	it('a project in no workspace is picked on its own', () => expect(loose).toEqual(['notes']));

	it('a workspace brings its projects along', () =>
		expect(listExported(WORKSPACES, ['admin'], [])).toEqual(['store-front']));

	it('everything picked is crew export --all', () =>
		expect(
			exportCommand({
				workspaces: WORKSPACES,
				loose,
				pickedWorkspaces: ['store-front', 'admin'],
				pickedLoose: ['notes'],
			}),
		).toEqual({ type: 'export', all: true }));

	it('a part names its projects (every one its workspaces use) and its workspaces', () =>
		expect(
			exportCommand({
				workspaces: WORKSPACES,
				loose,
				pickedWorkspaces: ['store-front'],
				pickedLoose: [],
			}),
		).toEqual({
			type: 'export',
			projects: ['store-front', 'store-api', 'signals'],
			workspaces: ['store-front'],
		}));

	it('projects alone: no --workspaces; nothing picked runs nothing', () => {
		expect(
			exportCommand({
				workspaces: WORKSPACES,
				loose,
				pickedWorkspaces: [],
				pickedLoose: ['notes'],
			}),
		).toEqual({
			type: 'export',
			projects: ['notes'],
		});
		expect(
			exportCommand({ workspaces: WORKSPACES, loose, pickedWorkspaces: [], pickedLoose: [] }),
		).toBeNull();
	});
});
