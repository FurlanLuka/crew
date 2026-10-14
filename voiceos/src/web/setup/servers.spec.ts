import { describe, expect, it } from 'bun:test';
import type { SetupCommand } from '../../crew/commands.js';
import {
	CARD_ACTIONS,
	type CardMode,
	actionCommand,
	describeHeadline,
	describeServerChip,
	listProjectLines,
	type LogTarget,
	logCommandFor,
	pickStartTarget,
	readCardMode,
	withSmokeSteps,
} from './servers.js';
import type { CrewIssue, CrewSetupStatus, CrewStep } from './types.js';
import type { ServerLine } from './worktree.js';

const REF = 'store/wrk1';

const line = (name: string, state: ServerLine['state'], project = 'store-api'): ServerLine => ({
	project,
	name,
	command: 'pnpm dev',
	port: null,
	url: null,
	state,
});

const status = (steps: CrewStep[], state = 'running'): CrewSetupStatus => ({
	ref: REF,
	running: state === 'running',
	failed: false,
	projects: [{ project: 'store-api', state, steps, issues: [] }],
	health: null,
});

const SMOKE_ISSUE: CrewIssue = {
	stage: 'smoke',
	project: 'store-api',
	server: 'api',
	reason: 'died',
	detail: '',
};
const INSTALL_ISSUE: CrewIssue = { stage: 'install', project: 'store-api', detail: '' };
const row = (patch: { installing?: boolean; dev_running?: boolean; issues?: CrewIssue[] }) => ({
	installing: false,
	dev_running: false,
	...patch,
});

describe('readCardMode', () => {
	it.each<[string, Parameters<typeof readCardMode>[0], CardMode]>([
		['nothing runs', { row: row({}), status: null, lines: [] }, 'stopped'],
		[
			'running, every server up',
			{ row: row({ dev_running: true }), status: null, lines: [line('api', 'up')] },
			'running',
		],
		[
			'running, a server died since',
			{ row: row({ dev_running: true }), status: null, lines: [line('api', 'died')] },
			'died',
		],
		[
			'a runner, status not read yet',
			{ row: row({ installing: true }), status: null, lines: [] },
			'installing',
		],
		[
			'a runner on its install step',
			{
				row: row({ installing: true }),
				status: status([
					{ name: 'checkout', status: 'ok' },
					{ name: 'pnpm install', status: 'running' },
				]),
				lines: [],
			},
			'installing',
		],
		[
			'a runner on its smoke steps',
			{
				row: row({ installing: true }),
				status: status([
					{ name: 'pnpm install', status: 'ok' },
					{ name: 'smoke api', status: 'running' },
				]),
				lines: [],
			},
			'verifying',
		],
		[
			'a runner beats a recorded failure (it is replacing it)',
			{
				row: row({ installing: true, issues: [SMOKE_ISSUE] }),
				status: status([{ name: 'smoke api', status: 'running' }]),
				lines: [],
			},
			'verifying',
		],
		[
			'an install failed',
			{ row: row({ issues: [INSTALL_ISSUE] }), status: null, lines: [] },
			'setup-failed',
		],
		[
			'a server died during verify, nothing runs',
			{ row: row({ issues: [SMOKE_ISSUE] }), status: null, lines: [] },
			'verify-failed',
		],
		[
			'a server died, the others run',
			{ row: row({ dev_running: true, issues: [SMOKE_ISSUE] }), status: null, lines: [] },
			'died',
		],
	])('%s → its mode', (_, input, mode) => expect(readCardMode(input)).toBe(mode));

	it('two runners: one trying its servers, one still installing → installing', () =>
		expect(
			readCardMode({
				row: row({ installing: true }),
				status: {
					...status([{ name: 'smoke api', status: 'running' }]),
					projects: [
						{
							project: 'store-api',
							state: 'running',
							steps: [{ name: 'smoke api', status: 'running' }],
							issues: [],
						},
						{
							project: 'store-front',
							state: 'running',
							steps: [{ name: 'pnpm install', status: 'running' }],
							issues: [],
						},
					],
				},
				lines: [],
			}),
		).toBe('installing'));

	it('a runner starting, no step yet → installing', () =>
		expect(
			readCardMode({ row: row({ installing: true }), status: status([], 'starting'), lines: [] }),
		).toBe('installing'));

	it('nothing to press while a runner works; a failed install is installed again', () => {
		expect(CARD_ACTIONS.installing).toEqual([]);
		expect(CARD_ACTIONS.verifying).toEqual([]);
		expect(CARD_ACTIONS['setup-failed']).toEqual(['install-again']);
		expect(CARD_ACTIONS.running).toEqual(['stop', 'restart', 'verify']);
	});
});

describe('withSmokeSteps', () => {
	it("each server's try: passed → up, failed → died, trying → not listening yet; untried stays", () => {
		const lines = [line('api', 'stopped'), line('worker', 'stopped'), line('db', 'stopped')];
		const doc = status([
			{ name: 'smoke api', status: 'ok' },
			{ name: 'smoke worker', status: 'failed' },
		]);

		expect(withSmokeSteps(lines, doc).map((each) => `${each.name}:${each.state}`)).toEqual([
			'api:up',
			'worker:died',
			'db:stopped',
		]);
		expect(withSmokeSteps(lines, null)).toEqual(lines);
	});

	it("two projects' servers with one name: each takes its own project's try", () => {
		const lines = [line('web', 'stopped', 'store-front'), line('web', 'stopped', 'store-api')];
		const doc: CrewSetupStatus = {
			...status([]),
			projects: [
				{
					project: 'store-front',
					state: 'running',
					steps: [{ name: 'smoke web', status: 'ok' }],
					issues: [],
				},
				{
					project: 'store-api',
					state: 'failed',
					steps: [{ name: 'smoke web', status: 'failed' }],
					issues: [],
				},
			],
		};

		expect(withSmokeSteps(lines, doc).map((each) => `${each.project}:${each.state}`)).toEqual([
			'store-front:up',
			'store-api:died',
		]);
	});
});

describe('logCommandFor', () => {
	const API = { project: 'store-api', server: 'api' };

	it.each<[CardMode, LogTarget, SetupCommand]>([
		['running', API, { type: 'dev_logs', ref: REF, server: 'api', lines: 200 }],
		['died', API, { type: 'dev_logs', ref: REF, server: 'api', lines: 200 }],
		['stopped', API, { type: 'dev_logs', ref: REF, server: 'api', lines: 200 }],
		[
			'verifying',
			API,
			{ type: 'setup_logs', ref: REF, project: 'store-api', server: 'api', lines: 200 },
		],
		[
			'verify-failed',
			API,
			{ type: 'setup_logs', ref: REF, project: 'store-api', server: 'api', lines: 200 },
		],
		['installing', API, { type: 'setup_logs', ref: REF, project: 'store-api', lines: 200 }],
		[
			'setup-failed',
			{ project: 'store-api', server: null },
			{ type: 'setup_logs', ref: REF, project: 'store-api', lines: 200 },
		],
	])('%s → %j opens %j', (mode, target, command) =>
		expect(logCommandFor({ mode, ref: REF, target, lines: 200 })).toEqual(command),
	);
});

describe('pickStartTarget', () => {
	it('a failed install → its project; a failed verify → its server; a death → that server; else none', () => {
		expect(pickStartTarget('setup-failed', [], INSTALL_ISSUE)).toEqual({
			project: 'store-api',
			server: null,
		});
		expect(pickStartTarget('verify-failed', [], SMOKE_ISSUE)).toEqual({
			project: 'store-api',
			server: 'api',
		});
		expect(pickStartTarget('died', [line('web', 'up'), line('api', 'died')], undefined)).toEqual({
			project: 'store-api',
			server: 'api',
		});
		expect(pickStartTarget('running', [line('web', 'up')], undefined)).toBeNull();
	});
});

describe('describeHeadline', () => {
	it.each<[CardMode, ServerLine[], CrewIssue | undefined, string]>([
		['stopped', [], undefined, 'Stopped'],
		['running', [line('web', 'up'), line('api', 'quiet')], undefined, 'Running · 1 of 2 listening'],
		['died', [line('web', 'up'), line('api', 'died')], undefined, 'api died'],
		['died', [line('web', 'up')], SMOKE_ISSUE, 'api died'],
		[
			'verifying',
			[line('web', 'up'), line('api', 'quiet')],
			undefined,
			'Verifying · 1 of 2 servers answered',
		],
		['setup-failed', [], INSTALL_ISSUE, 'store-api install failed'],
		['verify-failed', [], undefined, 'Something failed'],
	])('%s → %s', (mode, lines, issue, text) =>
		expect(describeHeadline({ mode, lines, issue })).toBe(text),
	);
});

describe('describeServerChip', () => {
	it('its state; a stopped one with a port says the port', () => {
		expect(describeServerChip(line('api', 'quiet'))).toBe('not listening yet');
		expect(describeServerChip(line('api', 'died'))).toBe('died');
		expect(describeServerChip({ ...line('api', 'stopped'), port: 3000 })).toBe(':3000');
		expect(describeServerChip(line('api', 'stopped'))).toBe('stopped');
	});
});

describe('actionCommand', () => {
	it('Install again re-runs each failed project once, even with two issues', () =>
		expect(
			actionCommand('install-again', REF, [
				INSTALL_ISSUE,
				{ ...SMOKE_ISSUE, project: 'store-api' },
				{ ...INSTALL_ISSUE, project: 'store-front' },
			]),
		).toEqual({ type: 'setup_rerun', ref: REF, projects: ['store-api', 'store-front'] }));

	it('the rest are the dev commands of the worktree', () => {
		expect(actionCommand('restart', REF, [])).toEqual({ type: 'dev_restart', ref: REF });
		expect(actionCommand('verify', REF, [])).toEqual({ type: 'verify', ref: REF });
	});
});

describe('listProjectLines', () => {
	it('no runner left → the members, only the failed one marked', () =>
		expect(
			listProjectLines({
				runners: [],
				members: ['store-front', 'store-api'],
				issue: INSTALL_ISSUE,
			}),
		).toEqual([
			{ project: 'store-front', state: 'ok', side: 'ready' },
			{ project: 'store-api', state: 'failed', side: 'failed' },
		]));

	it('runners → as they are', () => {
		const runners = [
			{ project: 'store-api', state: 'running' as const, steps: [], side: 'pnpm install' },
		];

		expect(listProjectLines({ runners, members: ['store-api'], issue: undefined })).toBe(runners);
	});
});
