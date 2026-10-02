import { describe, expect, it } from 'bun:test';
import { readGolden } from '../../../test/support/fake-crew.js';
import type { CrewMember, CrewProject, CrewRoute, CrewSmoke } from './types.js';
import { describeIssueWhy, listServerLines, readOverrides, toPinCommand } from './worktree.js';

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
	it('crew ls overrides --json → one row per pin, project ones keep their prefix', () => {
		expect(readOverrides(readGolden('ls-overrides.json'))).toEqual([
			{ key: 'STORE_API_URL', value: 'https://dev-api.example.com' },
			{ key: 'store-api.LOG_LEVEL', value: 'debug' },
		]);
	});

	it.each([[null], [[]], ['text']])('%j → no pins', (json) => {
		expect(readOverrides(json)).toEqual([]);
	});
});

describe('toPinCommand', () => {
	it.each([
		['STRIPE_KEY=sk_test_1', '', { var: 'STRIPE_KEY', value: 'sk_test_1' }],
		['URL=a=b', 'store-api', { var: 'store-api.URL', value: 'a=b' }],
		[' FLAG ', '', { var: 'FLAG', value: '' }],
	])('%p for %p → add_override', (pin, project, expected) => {
		expect(toPinCommand({ ref: 'store-front/main', pin, project })).toEqual({
			type: 'add_override',
			ref: 'store-front/main',
			...expected,
		});
	});

	it('no variable yet → nothing to run', () => {
		expect(toPinCommand({ ref: 'a/b', pin: '=x', project: '' })).toBeNull();
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
