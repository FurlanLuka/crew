import { describe, expect, it } from 'bun:test';
import { crumbsFor, pageAbove } from './crumbs.js';

describe('breadcrumbs', () => {
	it('a worktree page sits under Workspaces › its workspace', () =>
		expect(
			crumbsFor({ page: 'logs', ref: 'store-front/main' }).map((crumb) => crumb.label),
		).toEqual(['Workspaces', 'store-front', 'main', 'Logs']));

	it('Esc goes up one: logs → the worktree, a project → the board, the board → nowhere', () => {
		expect(pageAbove({ page: 'logs', ref: 'store-front/main' })).toEqual({
			page: 'worktree',
			ref: 'store-front/main',
		});
		expect(pageAbove({ page: 'project', name: 'signals' })).toEqual({
			page: 'board',
			tab: 'projects',
		});
		expect(pageAbove({ page: 'import' })).toEqual({ page: 'settings' });
		expect(pageAbove({ page: 'board', tab: 'projects' })).toBeNull();
	});
});
