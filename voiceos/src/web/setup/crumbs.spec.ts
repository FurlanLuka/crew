import { describe, expect, it } from 'bun:test';
import { crumbsFor, pageAbove } from './crumbs.js';

describe('breadcrumbs', () => {
	it('a worktree page sits under Workspaces › its workspace', () =>
		expect(
			crumbsFor({ page: 'rename', ref: 'store-front/main' }).map((crumb) => crumb.label),
		).toEqual(['Workspaces', 'store-front', 'main', 'Rename']));

	it('Esc goes up one: rename → the worktree, a project → its tab, chat → the board, the board → nowhere', () => {
		expect(pageAbove({ page: 'rename', ref: 'store-front/main' })).toEqual({
			page: 'worktree',
			ref: 'store-front/main',
		});
		expect(pageAbove({ page: 'project', name: 'signals' })).toEqual({
			page: 'board',
			tab: 'projects',
		});
		expect(pageAbove({ page: 'chat' })).toEqual({ page: 'board', tab: 'workspaces' });
		expect(pageAbove({ page: 'import' })).toEqual({ page: 'settings' });
		expect(pageAbove({ page: 'board', tab: 'workspaces' })).toBeNull();
	});
});
