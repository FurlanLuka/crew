import { describe, expect, it } from 'bun:test';
import type { SetupCommand } from '../../crew/commands.js';
import {
	CARD_ACTIONS,
	type CardMode,
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
