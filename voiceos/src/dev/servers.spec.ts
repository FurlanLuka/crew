import { describe, expect, it } from 'bun:test';
import type { DevServer } from '../shared/protocol.js';
import {
	confirmServersDown,
	buildFallbackFixPrompt,
	parseCheckRows,
	parseRouteRows,
	toServerState,
	decideStartReply,
	toServers,
	describeTransitions,
	formatVerdictLine,
	type CheckRow,
} from './servers.js';

const CHECK_JSON = JSON.stringify([
	{
		project: 'signals-api',
		server: 'signals-api',
		port: 51049,
		alive: true,
		listening: true,
		referenced: true,
		took_ms: 14,
	},
	{
		project: 'signals-app',
		server: 'signals-app',
		port: 51050,
		alive: true,
		listening: true,
		referenced: false,
		took_ms: 33,
	},
	{
		project: 'worker',
		server: 'worker',
		port: 0,
		alive: true,
		listening: false,
		referenced: false,
		took_ms: 2,
	},
]);
const ROUTES_JSON = JSON.stringify([
	{
		worktree: 'signals/wrk1',
		server_name: 'signals-api',
		external_port: 3000,
		url: 'http://localhost:51049',
	},
	{
		worktree: 'signals/main',
		server_name: 'signals-api',
		external_port: 3000,
		url: 'http://localhost:63470',
	},
]);

const createRow = (patch: Partial<CheckRow>): CheckRow => ({
	project: 'p',
	server: 's',
	port: 1,
	alive: true,
	listening: true,
	referenced: true,
	...patch,
});
const createServer = (name: string, state: DevServer['state']): DevServer => ({
	name,
	port: 1,
	url: null,
	state,
	detail: null,
});

describe('parsing crew output', () => {
	it('check and status JSON → rows; the URL joined by worktree and server name', () => {
		const servers = toServers({
			ref: 'signals/wrk1',
			rows: parseCheckRows(CHECK_JSON),
			routes: parseRouteRows(ROUTES_JSON),
		});
		expect(servers).toEqual([
			{
				name: 'signals-api',
				port: 51049,
				url: 'http://localhost:51049',
				state: 'running',
				detail: null,
			},
			{ name: 'signals-app', port: 51050, url: null, state: 'running', detail: null },
			{ name: 'worker', port: 0, url: null, state: 'running', detail: null },
		]);
	});

	it('malformed output → an error, not a crash later', () => {
		expect(() => parseCheckRows('not json')).toThrow();
		expect(() => parseCheckRows('{"a":1}')).toThrow('expected a JSON array');
		expect(parseCheckRows('[{"nope":true}]')).toEqual([]);
	});
});

describe('toServerState', () => {
	it('exited → died; running without listening → failing only when something points at it', () => {
		expect(toServerState(createRow({ alive: false }))).toBe('died');
		expect(toServerState(createRow({ listening: false, referenced: true }))).toBe('not listening');
		expect(toServerState(createRow({ listening: false, referenced: false }))).toBe('running');
		expect(toServerState(createRow({}))).toBe('running');
	});
});

describe('describeTransitions', () => {
	it('running → died is reported; repeated looks report nothing new', () => {
		const before = [createServer('api', 'running'), createServer('web', 'running')];
		const after = [createServer('api', 'died'), createServer('web', 'running')];
		expect(describeTransitions(before, after)).toEqual(['api']);
		expect(describeTransitions(after, after)).toEqual([]);
	});

	it('a server that left the list was stopped, not crashed; the first look reports nothing', () => {
		expect(describeTransitions([createServer('api', 'running')], [])).toEqual([]);
		expect(describeTransitions(undefined, [createServer('api', 'died')])).toEqual([]);
	});
});

describe('decideStartReply', () => {
	it('nothing running → stopped; all running → up; any failing → failing, named', () => {
		expect(decideStartReply(undefined)).toEqual({ kind: 'stopped' });
		expect(decideStartReply([createServer('api', 'running')])).toEqual({ kind: 'up' });
		expect(decideStartReply([createServer('api', 'died'), createServer('web', 'running')])).toEqual(
			{
				kind: 'failing',
				servers: ['api'],
			},
		);
	});
});

describe('formatVerdictLine', () => {
	it('all up → counted; failures → named with the fix offer', () => {
		expect(
			formatVerdictLine([
				createServer('api', 'running'),
				createServer('web', 'running'),
				createServer('db', 'running'),
				createServer('w', 'running'),
			]),
		).toEqual({ text: 'all four dev servers are up.', failing: [] });
		expect(formatVerdictLine([createServer('api', 'running')])).toEqual({
			text: 'the dev server is up.',
			failing: [],
		});
		expect(
			formatVerdictLine([
				createServer('api', 'died'),
				createServer('web', 'not listening'),
				createServer('db', 'running'),
			]),
		).toEqual({
			text: 'api died, and web is not answering. Want Claude to fix it?',
			failing: ['api', 'web'],
		});
		expect(formatVerdictLine([])).toEqual({ text: 'no dev servers came up.', failing: [] });
	});
});

describe('buildFallbackFixPrompt', () => {
	it('names the failing servers and the crew commands to fix them with', () => {
		const prompt = buildFallbackFixPrompt({
			ref: 'signals/wrk1',
			servers: [
				{ ...createServer('api', 'died'), port: 51049, detail: 'exit 1' },
				createServer('web', 'running'),
			],
		});
		expect(prompt).toContain('- api (port 51049): died — exit 1');
		expect(prompt).not.toContain('web');
		expect(prompt).toContain('crew dev logs signals/wrk1 <server>');
	});
});

describe('confirmServersDown', () => {
	const up = [createServer('api', 'running'), createServer('web', 'running')];
	const apiDied = [createServer('api', 'died'), createServer('web', 'running')];
	const apiSilent = [createServer('api', 'not listening'), createServer('web', 'running')];
	const FIRST_LOOK_MS = 100_000;

	it('first look that finds a server down → a suspect since now, nothing announced', () => {
		expect(
			confirmServersDown({ suspects: [], previous: up, next: apiDied, now: FIRST_LOOK_MS }),
		).toEqual({
			announce: [],
			suspects: [{ name: 'api', since: FIRST_LOOK_MS }],
		});
	});
	it('died, and still dead on the next look → announced once, no longer a suspect', () => {
		expect(
			confirmServersDown({
				suspects: [{ name: 'api', since: FIRST_LOOK_MS }],
				previous: apiDied,
				next: apiDied,
				now: FIRST_LOOK_MS + 10_000,
			}),
		).toEqual({ announce: ['api'], suspects: [] });
	});
	it('back up on the next look → dropped, nothing announced', () => {
		expect(
			confirmServersDown({
				suspects: [{ name: 'api', since: FIRST_LOOK_MS }],
				previous: apiDied,
				next: up,
				now: FIRST_LOOK_MS + 10_000,
			}),
		).toEqual({ announce: [], suspects: [] });
	});
	it('running but not listening (a slow boot) → quiet within the grace, announced once it has lasted a minute', () => {
		// Carried from look to look, as the watcher does.
		let suspects = confirmServersDown({
			suspects: [],
			previous: up,
			next: apiSilent,
			now: FIRST_LOOK_MS,
		}).suspects;

		for (const later of [10_000, 20_000, 50_000]) {
			const look = confirmServersDown({
				suspects,
				previous: apiSilent,
				next: apiSilent,
				now: FIRST_LOOK_MS + later,
			});
			expect(look.announce).toEqual([]);
			suspects = look.suspects;
		}

		expect(
			confirmServersDown({
				suspects,
				previous: apiSilent,
				next: apiSilent,
				now: FIRST_LOOK_MS + 60_000,
			}).announce,
		).toEqual(['api']);
	});
});
