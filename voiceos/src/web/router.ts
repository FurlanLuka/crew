// The page's three halves from location.pathname: Home (/), Voice OS (/voice…) and Set up
// (/setup…). matchRoute and buildPath are pure; useRoute is the pushState glue.
import { useCallback, useEffect, useState } from 'react';
import { LOCAL_MACHINE } from '../shared/machine-ref.js';
import type { View } from '../shared/protocol.js';

export type BoardTab = 'projects' | 'workspaces';

export type SetupPage =
	| { page: 'board'; tab: BoardTab }
	| { page: 'chat' }
	| { page: 'project'; name: string }
	| { page: 'project-new' }
	| { page: 'project-edit'; name: string }
	| { page: 'check'; name: string }
	| { page: 'workspace'; name: string }
	| { page: 'workspace-new' }
	| { page: 'workspace-edit'; name: string }
	| { page: 'worktree'; ref: string }
	| { page: 'worktree-new'; workspace: string }
	| { page: 'progress'; ref: string }
	| { page: 'logs'; ref: string }
	| { page: 'rename'; ref: string }
	| { page: 'duplicate'; ref: string }
	| { page: 'machine' }
	| { page: 'machine-new' }
	| { page: 'settings' }
	| { page: 'import' }
	| { page: 'export' };

export type VoiceRoute =
	| { kind: 'active' }
	| { kind: 'session'; ref: string }
	| { kind: 'activate'; machine?: string }
	| { kind: 'settings' };

// machine: the machine Set up configures; LOCAL_MACHINE for this Mac.
export type Route =
	| { half: 'home' }
	| { half: 'voice'; view: VoiceRoute }
	| { half: 'setup'; machine: string; page: SetupPage };

export const HOME_ROUTE: Route = { half: 'home' };
export const BOARD: SetupPage = { page: 'board', tab: 'projects' };

const decode = (segment: string): string => {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
};

const encode = (segment: string): string =>
	encodeURIComponent(segment).replace(/%3A/gi, ':').replace(/%40/g, '@');

// A ref keeps its slash as a path separator: each side is encoded on its own.
const encodeRef = (ref: string): string => ref.split('/').map(encode).join('/');

const matchVoice = (parts: string[]): VoiceRoute => {
	const [kind, ...rest] = parts;

	if (kind === 'session' && rest.length > 0) {
		return { kind: 'session', ref: rest.join('/') };
	}

	if (kind === 'activate') {
		return rest[0] ? { kind: 'activate', machine: rest[0] } : { kind: 'activate' };
	}

	if (kind === 'settings') {
		return { kind: 'settings' };
	}

	return { kind: 'active' };
};

const matchSetup = (parts: string[]): SetupPage => {
	const [first, second, third, fourth] = parts;

	switch (first) {
		case undefined:
		// The first run moved to Home; an old link to it lands on the board, which sends a first run
		// there.
		case 'welcome':
		case 'projects':
			return second === 'new' ? { page: 'project-new' } : BOARD;
		case 'workspaces':
			return second === 'new' ? { page: 'workspace-new' } : { page: 'board', tab: 'workspaces' };
		case 'chat':
		case 'machine':
		case 'settings':
		case 'import':
		case 'export':
			return { page: first };
		case 'machines':
			return second === 'new' ? { page: 'machine-new' } : { page: 'machine' };
		case 'project':
			if (!second) {
				return BOARD;
			}

			return third === 'edit'
				? { page: 'project-edit', name: second }
				: third === 'check'
					? { page: 'check', name: second }
					: { page: 'project', name: second };
		case 'workspace':
			if (!second) {
				return { page: 'board', tab: 'workspaces' };
			}

			return third === 'edit'
				? { page: 'workspace-edit', name: second }
				: third === 'new-worktree'
					? { page: 'worktree-new', workspace: second }
					: { page: 'workspace', name: second };
		case 'worktree': {
			if (!second || !third) {
				return { page: 'board', tab: 'workspaces' };
			}

			const ref = `${second}/${third}`;

			switch (fourth) {
				case 'progress':
				case 'logs':
				case 'rename':
				case 'duplicate':
					return { page: fourth, ref };
				default:
					return { page: 'worktree', ref };
			}
		}

		default:
			return BOARD;
	}
};

// search: location.search, which carries the machine Set up is on (?on=vm1).
export const matchRoute = (pathname: string, search = ''): Route => {
	const parts = pathname.split('/').filter(Boolean).map(decode);
	const [half, ...rest] = parts;

	if (half === 'voice') {
		return { half: 'voice', view: matchVoice(rest) };
	}

	if (half === 'setup') {
		const machine = new URLSearchParams(search).get('on') || LOCAL_MACHINE;

		return { half: 'setup', machine, page: matchSetup(rest) };
	}

	return HOME_ROUTE;
};

const setupPath = (page: SetupPage): string => {
	switch (page.page) {
		case 'board':
			return page.tab === 'workspaces' ? '/setup/workspaces' : '/setup';
		case 'chat':
		case 'machine':
		case 'settings':
		case 'import':
		case 'export':
			return `/setup/${page.page}`;
		case 'machine-new':
			return '/setup/machines/new';
		case 'project-new':
			return '/setup/projects/new';
		case 'workspace-new':
			return '/setup/workspaces/new';
		case 'project':
			return `/setup/project/${encode(page.name)}`;
		case 'project-edit':
			return `/setup/project/${encode(page.name)}/edit`;
		case 'check':
			return `/setup/project/${encode(page.name)}/check`;
		case 'workspace':
			return `/setup/workspace/${encode(page.name)}`;
		case 'workspace-edit':
			return `/setup/workspace/${encode(page.name)}/edit`;
		case 'worktree-new':
			return `/setup/workspace/${encode(page.workspace)}/new-worktree`;
		case 'worktree':
			return `/setup/worktree/${encodeRef(page.ref)}`;
		case 'progress':
		case 'logs':
		case 'rename':
		case 'duplicate':
			return `/setup/worktree/${encodeRef(page.ref)}/${page.page}`;
	}
};

const voicePath = (view: VoiceRoute): string => {
	switch (view.kind) {
		case 'active':
			return '/voice';
		case 'session':
			return `/voice/session/${encodeRef(view.ref)}`;
		case 'activate':
			return view.machine ? `/voice/activate/${encode(view.machine)}` : '/voice/activate';
		case 'settings':
			return '/voice/settings';
	}
};

export const buildPath = (route: Route): string => {
	switch (route.half) {
		case 'home':
			return '/';
		case 'voice':
			return voicePath(route.view);
		case 'setup': {
			const path = setupPath(route.page);

			return route.machine === LOCAL_MACHINE
				? path
				: `${path}?on=${encodeURIComponent(route.machine)}`;
		}
	}
};

// A Voice OS address and the server's view name the same screens; a session's `from` (how it was
// opened) is not part of its address.
export const toView = (route: VoiceRoute): View =>
	route.kind === 'session'
		? { kind: 'session', ref: route.ref }
		: route.kind === 'activate' && route.machine
			? { kind: 'activate', machine: route.machine }
			: { kind: route.kind };

export const toVoiceRoute = (view: View): VoiceRoute =>
	view.kind === 'session'
		? { kind: 'session', ref: view.ref }
		: view.kind === 'activate' && view.machine
			? { kind: 'activate', machine: view.machine }
			: { kind: view.kind };

// The same screen, whichever way it was opened: its address. A VoiceRoute is a View without `from`.
export const viewKey = (view: View): string => voicePath(toVoiceRoute(view));

export type Navigate = (route: Route, options?: { replace?: boolean }) => void;

const readLocation = (): Route => matchRoute(location.pathname, location.search);

export const useRoute = (): { route: Route; navigate: Navigate } => {
	const [route, setRoute] = useState<Route>(readLocation);

	useEffect(() => {
		const handlePop = () => setRoute(readLocation());

		window.addEventListener('popstate', handlePop);

		return () => window.removeEventListener('popstate', handlePop);
	}, []);

	const navigate = useCallback<Navigate>((next, options = {}) => {
		const path = buildPath(next);

		if (path !== `${location.pathname}${location.search}`) {
			if (options.replace) {
				history.replaceState(null, '', path);
			} else {
				history.pushState(null, '', path);
			}
		}

		setRoute(next);
	}, []);

	return { route, navigate };
};
