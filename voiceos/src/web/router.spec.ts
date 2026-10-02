import { describe, expect, it } from 'bun:test';
import { LOCAL_MACHINE } from '../shared/machine-ref.js';
import type { View } from '../shared/protocol.js';
import {
	type Route,
	type VoiceRoute,
	buildPath,
	matchRoute,
	toView,
	toVoiceRoute,
	viewKey,
} from './router.js';

describe('matchRoute', () => {
	it.each<[string, string, Route]>([
		['/', '', { half: 'home' }],
		['/nowhere', '', { half: 'home' }],
		['/voice', '', { half: 'voice', view: { kind: 'active' } }],
		['/voice/settings', '', { half: 'voice', view: { kind: 'settings' } }],
		['/voice/activate', '', { half: 'voice', view: { kind: 'activate' } }],
		['/voice/activate/vm1', '', { half: 'voice', view: { kind: 'activate', machine: 'vm1' } }],
		[
			'/voice/session/store-front/main',
			'',
			{ half: 'voice', view: { kind: 'session', ref: 'store-front/main' } },
		],
		[
			'/voice/session/vm1:store-front/main',
			'',
			{ half: 'voice', view: { kind: 'session', ref: 'vm1:store-front/main' } },
		],
		[
			'/setup',
			'',
			{ half: 'setup', machine: LOCAL_MACHINE, page: { page: 'board', tab: 'projects' } },
		],
		[
			'/setup/workspaces',
			'?on=vm1',
			{ half: 'setup', machine: 'vm1', page: { page: 'board', tab: 'workspaces' } },
		],
		[
			'/setup/project/signals/edit',
			'',
			{ half: 'setup', machine: LOCAL_MACHINE, page: { page: 'project-edit', name: 'signals' } },
		],
		[
			'/setup/worktree/store-front/main/logs',
			'',
			{ half: 'setup', machine: LOCAL_MACHINE, page: { page: 'logs', ref: 'store-front/main' } },
		],
		[
			'/setup/workspace/store-front/new-worktree',
			'',
			{
				half: 'setup',
				machine: LOCAL_MACHINE,
				page: { page: 'worktree-new', workspace: 'store-front' },
			},
		],
	])('%s%s → the route', (path, search, route) => expect(matchRoute(path, search)).toEqual(route));
});

describe('buildPath', () => {
	const routes: Route[] = [
		{ half: 'home' },
		{ half: 'voice', view: { kind: 'active' } },
		{ half: 'voice', view: { kind: 'session', ref: 'vm1:store-front/main' } },
		{ half: 'voice', view: { kind: 'activate', machine: 'vm1' } },
		{ half: 'voice', view: { kind: 'settings' } },
		{ half: 'setup', machine: LOCAL_MACHINE, page: { page: 'board', tab: 'projects' } },
		{ half: 'setup', machine: 'vm1', page: { page: 'project', name: 'infra-ops' } },
		{
			half: 'setup',
			machine: LOCAL_MACHINE,
			page: { page: 'progress', ref: 'store-front/search' },
		},
		{ half: 'setup', machine: LOCAL_MACHINE, page: { page: 'import' } },
		{ half: 'setup', machine: LOCAL_MACHINE, page: { page: 'machine-new' } },
		{ half: 'setup', machine: LOCAL_MACHINE, page: { page: 'check', name: 'signals' } },
	];

	it.each(routes)('%j survives a reload: matchRoute(buildPath(route)) is the route', (route) => {
		const path = buildPath(route);
		const [pathname = '', search = ''] = path.split(/(?=\?)/);

		expect(matchRoute(pathname, search)).toEqual(route);
	});

	it("another machine's page carries it in the query; this Mac's does not", () => {
		expect(buildPath({ half: 'setup', machine: 'vm1', page: { page: 'settings' } })).toBe(
			'/setup/settings?on=vm1',
		);
		expect(buildPath({ half: 'setup', machine: LOCAL_MACHINE, page: { page: 'settings' } })).toBe(
			'/setup/settings',
		);
	});
});

describe('toView / toVoiceRoute / viewKey', () => {
	it.each<[View, VoiceRoute]>([
		[{ kind: 'active' }, { kind: 'active' }],
		[{ kind: 'settings' }, { kind: 'settings' }],
		[{ kind: 'activate' }, { kind: 'activate' }],
		[
			{ kind: 'activate', machine: 'vm1' },
			{ kind: 'activate', machine: 'vm1' },
		],
		[
			{ kind: 'session', ref: 'vm1:store/main', from: 'active' },
			{ kind: 'session', ref: 'vm1:store/main' },
		],
	])('%j ↔ %j', (view, route) => {
		expect(toVoiceRoute(view)).toEqual(route);
		expect(toView(route)).toEqual(
			view.kind === 'session' ? { kind: 'session', ref: view.ref } : view,
		);
		expect(viewKey(view)).toBe(viewKey(route));
	});

	it('a session opened from Active is the same screen as one opened by its address', () => {
		expect(viewKey({ kind: 'session', ref: 'a/b', from: 'active' })).toBe(
			viewKey({ kind: 'session', ref: 'a/b' }),
		);
		expect(viewKey({ kind: 'activate' })).not.toBe(viewKey({ kind: 'activate', machine: 'vm1' }));
	});
});
