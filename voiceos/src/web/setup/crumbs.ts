// Set up's breadcrumbs, pure: the trail after the machine's name, and where Esc goes.
import type { BoardTab, SetupPage } from '../router.js';

export interface Crumb {
	label: string;
	// The page a click goes to; none for the current page.
	page?: SetupPage;
}

const projects = (): Crumb => ({ label: 'Projects', page: { page: 'board', tab: 'projects' } });
const workspaces = (): Crumb => ({
	label: 'Workspaces',
	page: { page: 'board', tab: 'workspaces' },
});
const workspaceCrumb = (name: string): Crumb => ({
	label: name,
	page: { page: 'workspace', name },
});
const projectCrumb = (name: string): Crumb => ({ label: name, page: { page: 'project', name } });

const worktreeCrumbs = (ref: string, here?: string): Crumb[] => {
	const [workspace = ref, worktree = ref] = ref.split('/');

	return here
		? [
				workspaces(),
				workspaceCrumb(workspace),
				{ label: worktree, page: { page: 'worktree', ref } },
				{ label: here },
			]
		: [workspaces(), workspaceCrumb(workspace), { label: worktree }];
};

// The trail after the machine's name, following the structure (not the click history).
export const crumbsFor = (page: SetupPage): Crumb[] => {
	switch (page.page) {
		case 'board':
			return [];
		case 'chat':
			return [{ label: 'Setup with Claude' }];
		case 'project':
			return [projects(), { label: page.name }];
		case 'project-new':
			return [projects(), { label: 'Add project' }];
		case 'project-edit':
			return [projects(), projectCrumb(page.name), { label: 'Edit setup' }];
		case 'check':
			return [projects(), projectCrumb(page.name), { label: 'Check' }];
		case 'workspace':
			return [workspaces(), { label: page.name }];
		case 'workspace-new':
			return [workspaces(), { label: 'New workspace' }];
		case 'workspace-edit':
			return [workspaces(), workspaceCrumb(page.name), { label: 'Edit projects' }];
		case 'worktree-new':
			return [workspaces(), workspaceCrumb(page.workspace), { label: 'New worktree' }];
		case 'worktree':
		case 'progress':
			return worktreeCrumbs(page.ref);
		case 'logs':
			return worktreeCrumbs(page.ref, 'Logs');
		case 'rename':
			return worktreeCrumbs(page.ref, 'Rename');
		case 'duplicate':
			return worktreeCrumbs(page.ref, 'Duplicate');
		case 'machine':
			return [{ label: 'Connection' }];
		case 'machine-new':
			return [{ label: 'Add a machine' }];
		case 'settings':
			return [{ label: 'Settings' }];
		case 'import':
			return [{ label: 'Settings', page: { page: 'settings' } }, { label: 'Import' }];
	}
};

// Esc goes up one: the crumb before the current page, or the board.
export const pageAbove = (page: SetupPage): SetupPage | null => {
	if (page.page === 'board') {
		return null;
	}

	const trail = crumbsFor(page);
	const above = trail.at(-2)?.page;

	return above ?? { page: 'board', tab: 'projects' as BoardTab };
};
