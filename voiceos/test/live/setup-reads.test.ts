// Every read Set up makes, against a real crew: the argv toCrewArgv builds, the reply /api/crew
// gives the page, and the page's own parsers over it. The goldens pin crew's shapes from the Go
// side; this is the same check from the page's side, end to end. Gated behind VOICEOS_LIVE=1 and
// CREW_BIN (cd crew && go build -o /tmp/crew .). It never touches the developer's crew: HOME and
// TMUX_TMPDIR are temp directories, so every tmux session it makes lives on its own tmux server.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSetupRunner, handleCrewRequest } from '../../src/crew/api.js';
import type { CrewRunner } from '../../src/crew/adapter.js';
import { type SetupCommand, type SetupCommandType, traitsOf } from '../../src/crew/commands.js';
import { configureLog } from '../../src/log.js';
import { LOCAL_MACHINE } from '../../src/shared/machine-ref.js';
import { deriveFirstRun, deriveProjectState, listProblems } from '../../src/web/setup/derive.js';
import { readPreview } from '../../src/web/setup/environment.js';
import { describeCost, readBases, readLogText, readPlan } from '../../src/web/setup/readers.js';
import { isRunning, listProgressLines } from '../../src/web/setup/progress.js';
import type {
	CrewCheckStatus,
	CrewEnvRow,
	CrewMember,
	CrewProject,
	CrewRoute,
	CrewSetupStatus,
	CrewSmoke,
	CrewWorkspace,
	CrewWorktree,
} from '../../src/web/setup/types.js';
import { readCheckouts } from '../../src/web/setup/Welcome.js';
import { listServerLines } from '../../src/web/setup/worktree.js';
import { LIVE_JSON_TYPES } from '../support/json-evidence.js';

const crewBin = process.env.CREW_BIN ?? '';
const isLive = process.env.VOICEOS_LIVE === '1' && crewBin !== '';
const REF = 'store-front/main';

// What the page receives from POST /api/crew.
interface PageReply {
	code: number;
	stdout: string;
	stderr: string;
	json?: unknown;
}

// Short on purpose: tmux socket paths have a ~100 byte limit.
const root = isLive ? mkdtempSync('/tmp/crl-') : '';
const home = join(root, 'home');
const tmuxDir = join(root, 't');

const OUTSIDE_HOME = new Set(['TMUX', 'TMUX_PANE', 'XDG_CONFIG_HOME', 'VOICEOS_KEYS_DIR']);

const crewEnv = (): Record<string, string> => {
	const env: Record<string, string> = {};

	for (const [key, value] of Object.entries(process.env)) {
		// Nothing that points crew at the developer's own files: HOME decides every path here.
		if (value !== undefined && !OUTSIDE_HOME.has(key)) {
			env[key] = value;
		}
	}

	return {
		...env,
		HOME: home,
		TMUX_TMPDIR: tmuxDir,
		GIT_AUTHOR_NAME: 'crew test',
		GIT_AUTHOR_EMAIL: 'test@example.com',
		GIT_COMMITTER_NAME: 'crew test',
		GIT_COMMITTER_EMAIL: 'test@example.com',
	};
};

// spawnRunner with the temp HOME: same stdin and timeout handling, its own environment.
const runLocal: CrewRunner = async (args, options) => {
	const stdin = options?.stdin;
	const child = Bun.spawn([crewBin, ...args], {
		env: crewEnv(),
		stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	let timedOut = false;
	const timer = options?.timeoutMs
		? setTimeout(() => {
				timedOut = true;
				child.kill();
			}, options.timeoutMs)
		: null;
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	if (timer) {
		clearTimeout(timer);
	}

	return { code, stdout, stderr, ...(timedOut ? { timedOut: true as const } : {}) };
};

const runCrew = createSetupRunner({
	runLocal,
	startLocal: () => {
		throw new Error('no detached commands in a read spec');
	},
	getLink: () => undefined,
});

// Every command that appends --json and got a document that parses: the guard in commands.spec
// counts on this spec for the ones no golden pins.
const documented = new Set<SetupCommandType>();

// Through the real handler, so the json field is exactly what the page gets.
const ask = async (command: SetupCommand): Promise<PageReply> => {
	const response = await handleCrewRequest({
		request: new Request('http://localhost/api/crew', {
			method: 'POST',
			headers: { origin: 'http://localhost', 'content-type': 'application/json' },
			body: JSON.stringify({ machine: LOCAL_MACHINE, command }),
		}),
		origins: ['http://localhost'],
		isAuthorized: true,
		runCrew,
	});
	const body = (await response.json()) as PageReply & { error?: string };

	if (response.status !== 200) {
		throw new Error(`${command.type}: ${response.status} ${body.error ?? ''}`);
	}

	if (traitsOf(command).json && body.json !== undefined) {
		documented.add(command.type);
	}

	return body;
};

const mustSucceed = async (command: SetupCommand): Promise<PageReply> => {
	const reply = await ask(command);

	if (reply.code !== 0) {
		throw new Error(`${command.type} exited ${reply.code}: ${reply.stderr.trim()}`);
	}

	return reply;
};

// crew exits 2 while a runner is alive, 1 when one failed: the page reads the code alongside.
const waitForSetup = async (ref: string, timeoutMs = 120_000): Promise<PageReply> => {
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		const reply = await ask({ type: 'setup_status', ref });

		if (reply.code !== 2 || Date.now() > deadline) {
			return reply;
		}

		await Bun.sleep(1000);
	}
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const expectArrayOf = (value: unknown, keys: Record<string, string>): void => {
	expect(Array.isArray(value)).toBe(true);

	for (const row of value as unknown[]) {
		expect(isObject(row)).toBe(true);

		for (const [key, type] of Object.entries(keys)) {
			expect(`${key}: ${typeof (row as Record<string, unknown>)[key]}`).toBe(`${key}: ${type}`);
		}
	}
};

const jsonOf = (reply: PageReply, codes: number[] = [0]): unknown => {
	expect(codes).toContain(reply.code);
	expect(reply.json).toBeDefined();

	return reply.json;
};

const git = (cwd: string, ...args: string[]): void => {
	const result = Bun.spawnSync(['git', ...args], { cwd, env: crewEnv() });

	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
	}
};

const makeRepo = (name: string, files: Record<string, string>): string => {
	const dir = join(home, 'code', name);
	mkdirSync(dir, { recursive: true });

	for (const [file, text] of Object.entries(files)) {
		writeFileSync(join(dir, file), text);
	}

	git(dir, 'init', '-q', '-b', 'main');
	git(dir, 'add', 'package.json');
	git(dir, 'commit', '-q', '-m', 'init');

	return dir;
};

// Every read variant of SetupCommand, listed by hand: the last test fails when one of them was not
// run, so a read added here needs a call in one of the tests.
type ReadType = Extract<
	SetupCommandType,
	| 'ls_projects'
	| 'ls_workspaces'
	| 'ls_worktrees'
	| 'ls_bindings'
	| 'ls_bindings_preview'
	| 'ls_overrides'
	| 'ls_bases'
	| 'show'
	| 'scan_checkouts'
	| 'setup_status'
	| 'setup_logs'
	| 'check_status'
	| 'dev_status'
	| 'dev_check'
	| 'dev_logs'
	| 'env'
	| 'fix'
	| 'import_plan'
	| 'export'
	| 'clean_dry_run'
	| 'trash'
	| 'config_show'
	| 'proxy_status'
	| 'update_check'
	| 'server_status'
	| 'machines_ls'
	| 'keys_status'
	| 'discord_status'
	| 'debug_tail'
	| 'doctor'
	| 'migrate_dry_run'
	| 'rm_workspace_project_dry_run'
	| 'rm_worktree_dry_run'
	| 'add_binding_dry_run'
	| 'add_binding_scan'
>;

describe.skipIf(!isLive)('every Set up read against a real crew', () => {
	let bundle = '';
	const seen = new Set<ReadType>();

	const read = async (command: Extract<SetupCommand, { type: ReadType }>): Promise<PageReply> => {
		seen.add(command.type);

		return ask(command);
	};

	beforeAll(async () => {
		configureLog({ quiet: true });
		mkdirSync(tmuxDir, { recursive: true });
		const api = makeRepo('store-api', { 'package.json': '{"name":"store-api"}\n' });
		const front = makeRepo('store-front', {
			'package.json': '{"name":"store-front"}\n',
			'.env': 'STORE_API_URL=http://localhost:4000\nSIGNALS_URL=http://localhost:5000\n',
		});

		await mustSucceed({ type: 'add_project', name: 'store-api', path: api, setup: 'true' });
		await mustSucceed({ type: 'add_project', name: 'store-front', path: front, setup: 'true' });
		await mustSucceed({
			type: 'dev_add',
			project: 'store-api',
			name: 'api',
			cmd: 'python3 -m http.server $PORT',
			port: 4000,
		});
		await mustSucceed({
			type: 'dev_add',
			project: 'store-front',
			name: 'web',
			cmd: 'python3 -m http.server $PORT',
			port: 3000,
		});
		await mustSucceed({
			type: 'add_binding',
			project: 'store-front',
			var: 'STORE_API_URL',
			value: '{{store-api}}',
		});
		await mustSucceed({
			type: 'add_workspace',
			name: 'store-front',
			projects: ['store-api', 'store-front'],
		});
		await waitForSetup(REF);
		await mustSucceed({ type: 'add_override', ref: REF, var: 'STRIPE_KEY', value: 'sk_test_1' });
		await mustSucceed({ type: 'check_project', project: 'store-api', no_smoke: true });
		await waitForSetup('check/store-api');
	}, 300_000);

	afterAll(async () => {
		if (!isLive) {
			return;
		}

		await ask({ type: 'dev_stop' }).catch(() => undefined);
		// The temp tmux server only: TMUX_TMPDIR points at this spec's own socket directory.
		Bun.spawnSync(['tmux', 'kill-server'], { env: crewEnv() });
		rmSync(root, { recursive: true, force: true });
	});

	it('the pool, workspaces and worktrees: the board, the problems strip and first run read them', async () => {
		const projects = jsonOf(await read({ type: 'ls_projects' })) as CrewProject[];
		expectArrayOf(projects, { name: 'string', remote: 'string', path: 'string' });
		expect(projects.map((project) => project.name).sort()).toEqual(['store-api', 'store-front']);
		expectArrayOf(
			projects.flatMap((project) => project.dev_servers ?? []),
			{
				name: 'string',
				command: 'string',
				port: 'number',
			},
		);

		const workspaces = jsonOf(await read({ type: 'ls_workspaces' })) as CrewWorkspace[];
		expectArrayOf(workspaces, { name: 'string', project_count: 'number', dev_running: 'boolean' });
		expect(workspaces[0]?.worktrees).toEqual(['main']);
		expectArrayOf(workspaces[0]?.wires ?? [], {
			var: 'string',
			from: 'string',
			to: 'string',
			ok: 'boolean',
		});

		const worktrees = jsonOf(await read({ type: 'ls_worktrees', size: true })) as CrewWorktree[];
		expectArrayOf(worktrees, {
			ref: 'string',
			path: 'string',
			dev_running: 'boolean',
			installing: 'boolean',
			size_bytes: 'number',
		});
		expect(worktrees.map((worktree) => worktree.ref)).toContain(REF);
		expect(deriveFirstRun(projects, worktrees)).toBe('ready');
		expect(projects.map((project) => deriveProjectState(project, worktrees))).toEqual([
			'ready',
			'ready',
		]);
		expect(listProblems(worktrees)).toEqual([]);

		const members = jsonOf(await read({ type: 'show', ref: REF })) as CrewMember[];
		expectArrayOf(members, { name: 'string', path: 'string', mode: 'string' });
	}, 60_000);

	it('a project: bindings, their preview, the --scan rows and a dry-run binding', async () => {
		expectArrayOf(jsonOf(await read({ type: 'ls_bindings', project: 'store-front' })), {
			var: 'string',
		});
		expect(
			Array.isArray(jsonOf(await read({ type: 'ls_bindings_preview', project: 'store-front' }))),
		).toBe(true);

		// crew add binding --scan stays a CLI read (the page no longer offers its proposals).
		expectArrayOf(jsonOf(await read({ type: 'add_binding_scan', project: 'store-front' })), {
			var: 'string',
			status: 'string',
		});

		const preview = readPreview(
			jsonOf(
				await read({
					type: 'add_binding_dry_run',
					project: 'store-front',
					var: 'API_HOST',
					value: '{{store-api.host}}',
				}),
			),
		);
		expect(preview.error).toBeNull();
		expect(preview.rows.map((row) => row.worktree)).toContain(REF);
		expect(preview.rows.every((row) => row.value?.startsWith('localhost:'))).toBe(true);

		const malformed = await read({
			type: 'add_binding_dry_run',
			project: 'store-front',
			var: 'API_HOST',
			value: '{{store-api.foo}}',
		});
		expect(readPreview(malformed.json).error).toBeTruthy();
	}, 60_000);

	it('a worktree: overrides, bases, setup status and logs, env, the removal costs', async () => {
		const overrides = jsonOf(await read({ type: 'ls_overrides', ref: REF }));
		expect(JSON.stringify(overrides)).toContain('STRIPE_KEY');

		const bases = readBases(jsonOf(await read({ type: 'ls_bases', workspace: 'store-front' })));
		expect(bases.map((base) => base.project).sort()).toEqual(['store-api', 'store-front']);

		const status = jsonOf(
			await read({ type: 'setup_status', ref: REF }),
			[0, 1],
		) as CrewSetupStatus;
		expect(status.ref).toBe(REF);
		expect(isRunning(status)).toBe(false);
		expect(listProgressLines(status).length).toBeGreaterThan(0);

		const logs = jsonOf(
			await read({ type: 'setup_logs', ref: REF, project: 'store-api', lines: 50 }),
		);
		expect(readLogText(logs).length).toBeGreaterThan(0);
		expect(readLogText(logs)).not.toContain('\u001b');

		const env = jsonOf(
			await read({ type: 'env', ref: REF, project: 'store-front' }),
		) as CrewEnvRow[];
		expectArrayOf(env, { var: 'string', value: 'string', source: 'string' });
		expect(env.map((row) => row.var)).toContain('STORE_API_URL');

		const cost = describeCost(jsonOf(await read({ type: 'rm_worktree_dry_run', ref: REF })));
		expect(cost.length).toBe(2);
		expect(
			describeCost(
				jsonOf(
					await read({
						type: 'rm_workspace_project_dry_run',
						workspace: 'store-front',
						project: 'store-api',
					}),
				),
			).length,
		).toBe(1);

		const check = jsonOf(
			await read({ type: 'check_status', project: 'store-api' }),
		) as CrewCheckStatus;
		expect(check.project).toBe('store-api');
		expect(['passed', 'none']).toContain(check.state);

		const fix = await read({ type: 'fix', ref: REF });
		expect(fix.code).toBe(0);
	}, 180_000);

	it('running servers: dev status, check and logs feed the worktree page', async () => {
		await mustSucceed({ type: 'dev_start', ref: REF });
		const deadline = Date.now() + 30_000;
		let checks: CrewSmoke[] = [];

		while (Date.now() < deadline) {
			checks = jsonOf(await read({ type: 'dev_check', ref: REF })) as CrewSmoke[];

			if (checks.length && checks.every((check) => check.listening)) {
				break;
			}

			await Bun.sleep(1000);
		}

		expectArrayOf(checks, {
			project: 'string',
			server: 'string',
			port: 'number',
			alive: 'boolean',
			listening: 'boolean',
		});

		const routes = jsonOf(await read({ type: 'dev_status', ref: REF })) as CrewRoute[];
		expectArrayOf(routes, {
			worktree: 'string',
			server_name: 'string',
			external_port: 'number',
			url: 'string',
		});

		const projects = jsonOf(await ask({ type: 'ls_projects' })) as CrewProject[];
		const members = jsonOf(await ask({ type: 'show', ref: REF })) as CrewMember[];
		const lines = listServerLines({ members, projects, checks, routes, worktreeRef: REF });
		expect(lines.map((line) => `${line.project}/${line.name} ${line.state}`).sort()).toEqual([
			'store-api/api up',
			'store-front/web up',
		]);
		expect(lines.every((line) => line.url?.startsWith('http://localhost:'))).toBe(true);

		const logs = readLogText(
			jsonOf(await read({ type: 'dev_logs', ref: REF, server: 'api', lines: 20 })),
		);
		expect(logs).not.toContain('\u001b');
		await mustSucceed({ type: 'dev_stop', ref: REF });
	}, 90_000);

	it('moving machines: the export on stdout reads back as the plan', async () => {
		const exported = await read({ type: 'export', all: true });
		expect(exported.code).toBe(0);
		expect(exported.json).toBeUndefined();
		bundle = exported.stdout;
		expect((JSON.parse(bundle) as { version: number }).version).toBe(2);
		expect(exported.stderr).toContain('2 projects, 1 workspace');

		const plan = readPlan(jsonOf(await read({ type: 'import_plan', bundle })));
		expect(plan.map((row) => `${row.kind} ${row.name} ${row.status}`)).toEqual([
			'project store-api exists',
			'project store-front exists',
			'workspace store-front exists',
		]);
	}, 60_000);

	it('this machine: scan, settings, housekeeping, the server and its keys', async () => {
		const checkouts = readCheckouts(jsonOf(await read({ type: 'scan_checkouts' })));
		expect(checkouts.map((row) => `${row.name} ${row.known}`).sort()).toEqual([
			'store-api true',
			'store-front true',
		]);

		expect(Array.isArray(jsonOf(await read({ type: 'clean_dry_run' })))).toBe(true);
		expect(isObject(jsonOf(await read({ type: 'trash' })))).toBe(true);
		expect(isObject(jsonOf(await read({ type: 'config_show' })))).toBe(true);
		expect(isObject(jsonOf(await read({ type: 'proxy_status' })))).toBe(true);

		const update = jsonOf(await read({ type: 'update_check' })) as Record<string, unknown>;
		expect(typeof update.current).toBe('string');
		expect(typeof update.available).toBe('boolean');

		const server = jsonOf(await read({ type: 'server_status' }), [0, 1]) as Record<string, unknown>;
		expect(server.running).toBe(false);

		expectArrayOf(jsonOf(await read({ type: 'machines_ls' })), { id: 'string', host: 'string' });
		expectArrayOf(jsonOf(await read({ type: 'keys_status' })), {
			name: 'string',
			set: 'boolean',
		});
		expect(isObject(jsonOf(await read({ type: 'discord_status' })))).toBe(true);

		const tail = await read({ type: 'debug_tail', lines: 20 });
		expect(tail.code).toBe(0);
		expect(tail.json).toBeUndefined();

		expect(jsonOf(await read({ type: 'doctor' }), [0, 1])).toBeDefined();
		expect(Array.isArray(jsonOf(await read({ type: 'migrate_dry_run' })))).toBe(true);
	}, 120_000);

	it('every mutation that appends --json prints one document on stdout', async () => {
		const doc = async (command: SetupCommand, codes = [0]): Promise<unknown> =>
			jsonOf(await ask(command), codes);

		await doc({ type: 'add_worktree', ref: 'store-front/wrk2', no_install: true, no_smoke: true });
		await waitForSetup('store-front/wrk2');
		await doc({ type: 'rename_worktree', ref: 'store-front/wrk2', name: 'wrk3' });
		await doc({ type: 'setup_rerun', ref: 'store-front/wrk3', no_smoke: true });
		await waitForSetup('store-front/wrk3');
		await doc({ type: 'verify', ref: 'store-front/wrk3' });
		await waitForSetup('store-front/wrk3');
		await doc({ type: 'duplicate_worktree', ref: 'store-front/wrk3', name: 'wrk4' });
		await waitForSetup('store-front/wrk4');
		await doc({ type: 'dev_restart', ref: REF });
		await mustSucceed({ type: 'dev_stop', ref: REF });

		// The bundle the export test read back: everything in it is here already.
		expect(bundle).not.toBe('');
		await doc({ type: 'import_project', bundle, name: 'store-api', replace: true, confirm: true });
		await doc({ type: 'import_workspace', bundle, name: 'store-front' }, [0, 1]);
		await doc({ type: 'import_all', bundle });

		await doc({ type: 'clean', confirm: true });
		await doc({ type: 'proxy_trust' });
		await doc({ type: 'machines_add', host: 'build-box', name: 'Build box' });
		const machines = (await doc({ type: 'machines_ls' })) as { id: string }[];
		const id = machines[0]?.id ?? 'build-box';
		await doc({ type: 'machines_rename', id, name: 'Build server' });
		await doc({ type: 'machines_rm', id, confirm: true });
		await doc({ type: 'discord_off' });
	}, 300_000);

	it('every variant proven live by commands.spec printed its document here', () => {
		expect(LIVE_JSON_TYPES.filter((type) => !documented.has(type))).toEqual([]);
	});

	it('ran every read', () => {
		const all: Record<ReadType, true> = {
			ls_projects: true,
			ls_workspaces: true,
			ls_worktrees: true,
			ls_bindings: true,
			ls_bindings_preview: true,
			ls_overrides: true,
			ls_bases: true,
			show: true,
			scan_checkouts: true,
			setup_status: true,
			setup_logs: true,
			check_status: true,
			dev_status: true,
			dev_check: true,
			dev_logs: true,
			env: true,
			fix: true,
			import_plan: true,
			export: true,
			clean_dry_run: true,
			trash: true,
			config_show: true,
			proxy_status: true,
			update_check: true,
			server_status: true,
			machines_ls: true,
			keys_status: true,
			discord_status: true,
			debug_tail: true,
			doctor: true,
			migrate_dry_run: true,
			rm_workspace_project_dry_run: true,
			rm_worktree_dry_run: true,
			add_binding_dry_run: true,
			add_binding_scan: true,
		};

		expect([...seen].sort()).toEqual(Object.keys(all).sort() as ReadType[]);
	});
});
