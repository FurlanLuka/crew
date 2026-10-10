import { describe, expect, it } from 'bun:test';
import { readGolden } from '../../../test/support/fake-crew.js';
import type { CrewMember, CrewProject, CrewRoute, CrewSmoke } from './types.js';
import {
	describeIssueWhy,
	describeOverride,
	desktopFolder,
	desktopLink,
	listServerLines,
	readOverrides,
	toOverrideCommand,
} from './worktree.js';

const PROJECTS = readGolden<CrewProject[]>('ls-projects.json');
const CHECKS = readGolden<CrewSmoke[]>('dev-check.json');
const ROUTES = readGolden<CrewRoute[]>('dev-status.json');
const MEMBERS: CrewMember[] = [
	{ name: 'store-front', path: '/w/store-front/main/store-front', mode: 'worktree' },
	{ name: 'store-api', path: '/w/store-front/main/store-api', mode: 'worktree' },
];

describe('listServerLines (crew goldens)', () => {
	it('every declared server with what crew sees of it: up, died, running with no port', () => {
		const lines = listServerLines({
			members: MEMBERS,
			projects: PROJECTS,
			checks: CHECKS,
			routes: ROUTES,
			worktreeRef: 'store-front/main',
		});

		expect(lines.map((line) => [line.project, line.name, line.state, line.port, line.url])).toEqual(
			[
				['store-front', 'web', 'up', 54010, 'http://localhost:54010'],
				['store-api', 'api', 'died', 54012, 'http://localhost:54012'],
				['store-api', 'worker', 'up', null, null],
			],
		);
	});

	it('servers not running → stopped, from their declaration alone', () => {
		const lines = listServerLines({
			members: MEMBERS,
			projects: PROJECTS,
			checks: [],
			routes: [],
			worktreeRef: 'store-front/main',
		});

		expect(lines.map((line) => line.state)).toEqual(['stopped', 'stopped', 'stopped']);
	});

	it("another worktree's routes are never this one's links", () => {
		const lines = listServerLines({
			members: MEMBERS,
			projects: PROJECTS,
			checks: [],
			routes: ROUTES,
			worktreeRef: 'store-front/wrk1',
		});

		expect(lines.every((line) => line.url === null)).toBe(true);
	});

	it('two members with a server of one name → each its own route', () => {
		const projects: CrewProject[] = [
			{
				name: 'store-front',
				remote: '',
				dev_servers: [{ name: 'web', command: 'pnpm dev', port: 3000 }],
			},
			{
				name: 'admin',
				remote: '',
				dev_servers: [{ name: 'web', command: 'pnpm dev', port: 3001 }],
			},
		];
		const routes: CrewRoute[] = [
			{
				worktree: 'store-front/main',
				project: 'store-front',
				server_name: 'web',
				external_port: 3000,
				url: 'http://localhost:54010',
			},
			{
				worktree: 'store-front/main',
				project: 'admin',
				server_name: 'web',
				external_port: 3001,
				url: 'http://localhost:54011',
			},
		];
		const lines = listServerLines({
			members: [
				{ name: 'store-front', path: '/w/store-front/main/store-front', mode: 'worktree' },
				{ name: 'admin', path: '/w/store-front/main/admin', mode: 'worktree' },
			],
			projects,
			checks: [],
			routes,
			worktreeRef: 'store-front/main',
		});

		expect(lines.map((line) => [line.project, line.url])).toEqual([
			['store-front', 'http://localhost:54010'],
			['admin', 'http://localhost:54011'],
		]);
	});
});

describe('readOverrides', () => {
	it('crew ls overrides --json → one row per value, project ones keep their prefix', () => {
		expect(readOverrides(readGolden('ls-overrides.json'))).toEqual([
			{ key: 'STORE_API_URL', value: 'https://dev-api.example.com' },
			{ key: 'store-api.LOG_LEVEL', value: 'debug' },
		]);
	});

	it.each([[null], [[]], ['text']])('%j → no values', (json) => {
		expect(readOverrides(json)).toEqual([]);
	});
});

describe('toOverrideCommand', () => {
	it.each([
		['STRIPE_KEY=sk_test_1', '', { var: 'STRIPE_KEY', value: 'sk_test_1' }],
		['URL=a=b', 'store-api', { var: 'store-api.URL', value: 'a=b' }],
		[' FLAG ', '', { var: 'FLAG', value: '' }],
	])('%p for %p → add_override', (text, project, expected) => {
		expect(toOverrideCommand({ ref: 'store-front/main', text, project })).toEqual({
			type: 'add_override',
			ref: 'store-front/main',
			...expected,
		});
	});

	it('no variable yet → nothing to run', () => {
		expect(toOverrideCommand({ ref: 'a/b', text: '=x', project: '' })).toBeNull();
	});
});

describe('describeOverride', () => {
	const members = [
		{ name: 'store-front', path: '/w/store-front', mode: 'worktree' },
		{ name: 'store-api', path: '/w/store-api', mode: 'worktree' },
	];
	const projects = PROJECTS;

	it("every project, one of them binds it → what it replaces, by that project's name", () => {
		expect(describeOverride('STORE_API_URL', members, projects)).toEqual({
			key: 'STORE_API_URL',
			name: 'STORE_API_URL',
			scope: 'every project',
			instead: "instead of store-front's value: store-api api's URL",
		});
	});

	it("one project's value → the project's own binding, or nothing it replaces", () => {
		expect(describeOverride('store-front.STORE_API_URL', members, projects).instead).toBe(
			"instead of the project's value: store-api api's URL",
		);
		expect(describeOverride('store-api.LOG_LEVEL', members, projects)).toEqual({
			key: 'store-api.LOG_LEVEL',
			name: 'LOG_LEVEL',
			scope: 'store-api only',
			instead: null,
		});
	});

	it('only a server-scoped binding → it still replaces it, and names the server', () => {
		const scoped = projects.map((project) =>
			project.name === 'store-api'
				? { ...project, bindings: [{ var: 'LOG_LEVEL', value: 'debug', server: 'api' }] }
				: project,
		);

		expect(describeOverride('store-api.LOG_LEVEL', members, scoped).instead).toBe(
			"instead of the project's value: debug, fixed (api)",
		);
		expect(describeOverride('LOG_LEVEL', members, scoped).instead).toBe(
			"instead of store-api's value: debug, fixed (api)",
		);
	});

	it('scoped and project-wide in one project → that project once', () => {
		const both = projects.map((project) =>
			project.name === 'store-front'
				? {
						...project,
						bindings: [
							...(project.bindings ?? []),
							{ var: 'STORE_API_URL', value: 'http://x', server: 'web' },
						],
					}
				: project,
		);

		expect(describeOverride('STORE_API_URL', members, both).instead).toBe(
			"instead of store-front's 2 values",
		);
	});

	it('several projects bind it → how many, not one of them', () => {
		const both = projects.map((project) =>
			project.name === 'store-api'
				? { ...project, bindings: [{ var: 'STORE_API_URL', value: 'http://x' }] }
				: project,
		);

		expect(describeOverride('STORE_API_URL', members, both).instead).toBe(
			'instead of the values of 2 projects',
		);
	});
});

describe('describeIssueWhy', () => {
	it.each([
		[{ stage: 'install', project: 'store-api', detail: '' }, "store-api's install failed here"],
		[{ stage: 'checkout', project: 'store-api', detail: '' }, 'git could not check store-api out'],
		[
			{ stage: 'smoke', project: 'store-api', server: 'api', reason: 'not listening', detail: '' },
			'api runs but never answered on its port',
		],
		[{ stage: 'smoke', project: 'store-api', reason: 'died', detail: '' }, 'store-api stopped'],
	])('%j → %p', (issue, text) => {
		expect(describeIssueWhy(issue)).toContain(text);
	});
});

describe('desktopLink', () => {
	it('a host → the link, the folder encoded whole', () => {
		expect(desktopLink({ sshHost: 'build-box', folder: '/w/store-front/main' })).toBe(
			'claude://code/new?ssh_host=build-box&ssh_folder=%2Fw%2Fstore-front%2Fmain',
		);
		expect(desktopLink({ sshHost: 'build-box', folder: '/Users/dev/My Code/store-api' })).toBe(
			'claude://code/new?ssh_host=build-box&ssh_folder=%2FUsers%2Fdev%2FMy%20Code%2Fstore-api',
		);
	});

	it("another machine's SSH host, user included", () => {
		expect(desktopLink({ sshHost: 'dev@vm1', folder: '/w/store-front/main' })).toBe(
			'claude://code/new?ssh_host=dev%40vm1&ssh_folder=%2Fw%2Fstore-front%2Fmain',
		);
	});

	it('no host → no link', () => {
		expect(desktopLink({ sshHost: '', folder: '/w/store-front/main' })).toBeNull();
	});
});

describe('desktopFolder', () => {
	it("one project → its checkout; several → the worktree's root", () => {
		expect(desktopFolder(MEMBERS.slice(0, 1), '/w/store-front/main')).toBe(
			'/w/store-front/main/store-front',
		);
		expect(desktopFolder(MEMBERS, '/w/store-front/main')).toBe('/w/store-front/main');
	});
});
