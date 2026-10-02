// A stand-in crew for the page's tests and the docs screenshots: stateful, in memory, one per test
// run, injected as GatewayOptions.runCrew. Its reads answer in crew's own JSON shapes, taken from the
// Go-written goldens in voiceos/testdata/ (crew's tests write them from the functions the commands
// print), and its mutations change what the next read says. A command it does not model answers
// code 2, "fake crew: unhandled <type>", so a test never passes on a silent default.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CrewFailureReason, SetupReply, RunSetupCommand } from '../../src/crew/api.js';
import { type SetupCommand, traitsOf } from '../../src/crew/commands.js';
import { LOCAL_MACHINE } from '../../src/shared/machine-ref.js';
import type {
	CrewIssue,
	CrewProject,
	CrewProjectStatus,
	CrewSetupStatus,
	CrewWire,
} from '../../src/web/setup/types.js';

const TESTDATA = join(import.meta.dir, '..', '..', 'testdata');

export const readGolden = <T>(name: string): T =>
	JSON.parse(readFileSync(join(TESTDATA, name), 'utf8')) as T;

const LINES = readGolden<Record<string, string>>('crew-lines.json');

interface FakeWorkspace {
	name: string;
	projects: { name: string; mode: string }[];
	worktrees: string[];
}

interface FakeRun {
	startedAt: number;
	projects: string[];
	// Projects whose install fails in this run.
	failing: string[];
	// The other projects' last results: a re-run of some projects leaves crew's result files for the
	// rest where they are.
	kept: CrewProjectStatus[];
}

interface FakeWorktree {
	ref: string;
	devRunning: boolean;
	sizeBytes: number;
	overrides: Record<string, string>;
	issues: CrewIssue[];
	run: FakeRun | null;
}

interface FakeVoiceMachine {
	id: string;
	host: string;
	name: string;
	status?: string;
	detail?: string;
}

export interface FakeMachine {
	projects: CrewProject[];
	workspaces: FakeWorkspace[];
	worktrees: FakeWorktree[];
	checks: Record<string, FakeRun>;
	scan: { name: string; path: string; remote: string; known: boolean }[];
	trashBytes: number;
	// What crew clean --dry-run --json answers: the golden unless a test sets its own rows.
	cleanDryRun: unknown[];
	// crew server machines: the other machines this one's Voice OS drives.
	voiceMachines: FakeVoiceMachine[];
	isDiscordSetUp: boolean;
	// Workspaces from before crew 2.0, which crew migrate moves.
	flatWorkspaces: string[];
}

interface MachineFailure {
	reason: CrewFailureReason;
	version?: string;
}

export interface FakeCrewOptions {
	// 'golden': crew's goldens as this Mac's state; 'empty': a first run.
	seed?: 'golden' | 'empty';
	// How long a setup runner takes before its verdict.
	runMs?: number;
	// Other machines, by id: each starts as a copy of the seed.
	remotes?: string[];
	// The clock runners are timed by: a test steps it instead of sleeping.
	now?: () => number;
}

export interface FakeCrew {
	runCrew: RunSetupCommand;
	machines: Record<string, FakeMachine>;
	calls: { machine: string; command: SetupCommand }[];
	// The next install of these projects fails, with crew's real pnpm error.
	failInstall: (project: string) => void;
	// Every command for this machine fails the way the link fails it (out of reach, an older crew),
	// until reset; null puts it back.
	failMachine: (id: string, failure: MachineFailure | null) => void;
	reset: (seed?: 'golden' | 'empty') => void;
}

const INSTALL_ERROR = 'pnpm install:\nERR_PNPM_NO_MATCHING_VERSION';

const seedMachine = (seed: 'golden' | 'empty'): FakeMachine => {
	const scan = readGolden<FakeMachine['scan']>('scan-checkouts.json');

	if (seed === 'empty') {
		return {
			projects: [],
			workspaces: [],
			worktrees: [],
			checks: {},
			scan: scan.map((row) => ({ ...row, known: false })),
			trashBytes: 0,
			cleanDryRun: readGolden<unknown[]>('clean-dry-run.json'),
			voiceMachines: readGolden<FakeVoiceMachine[]>('server-machines-empty.json'),
			isDiscordSetUp: readGolden<{ set_up: boolean }>('server-discord-off.json').set_up,
			flatWorkspaces: [],
		};
	}

	const workspaces = readGolden<(FakeWorkspace & { wires: CrewWire[] })[]>('ls-workspaces.json');
	const worktrees =
		readGolden<{ ref: string; dev_running: boolean; size_bytes?: number; issues?: CrewIssue[] }[]>(
			'ls-worktrees-setup.json',
		);
	const overrides = readGolden<Record<string, string>>('ls-overrides.json');

	return {
		projects: readGolden<CrewProject[]>('ls-projects.json'),
		workspaces: workspaces.map(({ name, projects, worktrees: names }) => ({
			name,
			projects,
			worktrees: names,
		})),
		worktrees: worktrees
			.filter((row) => !row.ref.startsWith('check/'))
			.map((row) => ({
				ref: row.ref,
				devRunning: row.dev_running,
				sizeBytes: row.size_bytes ?? 0,
				overrides: row.ref === 'store-front/main' ? { ...overrides } : {},
				issues: row.issues ?? [],
				run: null,
			})),
		// The goldens keep a failed check of store-api (check/store-api): its install failed.
		checks: {
			'store-api': { startedAt: 0, projects: ['store-api'], failing: ['store-api'], kept: [] },
		},
		scan,
		trashBytes: readGolden<{ bytes: number }>('trash.json').bytes,
		cleanDryRun: readGolden<unknown[]>('clean-dry-run.json'),
		voiceMachines: readGolden<FakeVoiceMachine[]>('server-machines.json'),
		isDiscordSetUp: readGolden<{ set_up: boolean }>('server-discord-status.json').set_up,
		flatWorkspaces: [],
	};
};

const ok = (stdout: unknown, stderr = ''): SetupReply => ({
	kind: 'ran',
	result: { code: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr },
});

const json = (value: unknown, code = 0, stderr = ''): SetupReply => ({
	kind: 'ran',
	result: { code, stdout: JSON.stringify(value), stderr },
});

const refuse = (line: string): SetupReply => ({
	kind: 'ran',
	result: { code: 1, stdout: '', stderr: `Error: ${line}\n` },
});

const said = (line: string): SetupReply => ({
	kind: 'ran',
	result: { code: 0, stdout: '', stderr: `${line}\n` },
});

// crew export's file (transfer.Bundle, version 2): projects by their remote, path left behind, and
// workspace membership. Never worktrees, ports or worktree values.
interface FakeBundle {
	version: number;
	projects: (Omit<CrewProject, 'path' | 'remote'> & { remote?: string })[];
	workspaces: { name: string; projects: { name: string; mode: string }[] }[];
}

interface PlanRow {
	kind: 'project' | 'workspace';
	name: string;
	status: string;
	detail?: string;
}

const clonePath = (name: string): string => `/Users/dev/.crew/projects/${name}`;

const plural = (count: number, noun: string): string =>
	count === 1 ? `1 ${noun}` : `${count} ${noun}s`;

// crew reads the bundle from stdin; one it cannot read is refused the way readBundle words it.
const readBundle = (text: string): FakeBundle | null => {
	try {
		const bundle = JSON.parse(text) as FakeBundle;

		return bundle.version === 2 && Array.isArray(bundle.projects) ? bundle : null;
	} catch {
		return null;
	}
};

const BAD_BUNDLE = 'stdin is not a crew export (version 2)';

const STEP_NAMES = (project: CrewProject | undefined): string[] => [
	'checkout',
	project?.setup ?? 'install',
	...(project?.dev_servers ?? []).map((server) => `smoke ${server.name}`),
];

// What a runner has done by now: every step ok, or the install failed; still running until runMs.
const readRun = (
	run: FakeRun,
	projects: CrewProject[],
	runMs: number,
	now: number,
): CrewProjectStatus[] =>
	run.projects.map((name) => {
		const project = projects.find((row) => row.name === name);
		const steps = STEP_NAMES(project);
		const elapsed = now - run.startedAt;
		const isFailing = run.failing.includes(name);
		const at = new Date(run.startedAt).toISOString();

		if (elapsed < runMs) {
			const done = Math.min(steps.length - 1, Math.floor((elapsed / runMs) * steps.length));

			return {
				project: name,
				state: 'running',
				steps: steps.slice(0, done + 1).map((step, index) => ({
					name: step,
					status: index < done ? 'ok' : 'running',
					started_at: at,
					...(index < done ? { took_ms: 900 } : {}),
				})),
				issues: [],
				at,
			};
		}

		if (isFailing) {
			return {
				project: name,
				state: 'failed',
				steps: [
					{ name: 'checkout', status: 'ok', started_at: at, took_ms: 900 },
					{
						name: steps[1] ?? 'install',
						status: 'failed',
						started_at: at,
						took_ms: 8100,
						detail: 'ERR_PNPM_NO_MATCHING_VERSION',
					},
				],
				issues: [{ stage: 'install', project: name, detail: INSTALL_ERROR }],
				took_ms: 9000,
				at,
			};
		}

		return {
			project: name,
			state: 'ok',
			steps: steps.map((step) => ({ name: step, status: 'ok', started_at: at, took_ms: 1200 })),
			issues: [],
			took_ms: runMs,
			at,
		};
	});

const toStatus = (
	ref: string,
	projects: CrewProjectStatus[],
	now: number,
): { doc: CrewSetupStatus; code: number } => {
	const running = projects.some(
		(project) => project.state === 'running' || project.state === 'starting',
	);
	const issues = projects.flatMap((project) => project.issues);
	const failed = !running && issues.length > 0;

	return {
		doc: {
			ref,
			running,
			failed,
			projects,
			health: issues.length ? { at: new Date(now).toISOString(), issues } : null,
		},
		code: running ? 2 : failed ? 1 : 0,
	};
};

export const createFakeCrew = ({
	seed = 'golden',
	runMs = 1500,
	remotes = [],
	now: clock = Date.now,
}: FakeCrewOptions = {}): FakeCrew => {
	const machines: Record<string, FakeMachine> = {};
	const calls: FakeCrew['calls'] = [];
	const failNext = new Set<string>();
	const failing = new Map<string, MachineFailure>();

	const reset = (next: 'golden' | 'empty' = seed) => {
		for (const id of [LOCAL_MACHINE, ...remotes]) {
			machines[id] = seedMachine(next);
		}

		failNext.clear();
		failing.clear();
	};

	reset(seed);

	const startRun = (projects: string[]): FakeRun => {
		const failing = projects.filter((project) => failNext.has(project));

		for (const project of failing) {
			failNext.delete(project);
		}

		return { startedAt: clock(), projects, failing, kept: [] };
	};

	// Every project's last result on a worktree: the kept ones, then this run's.
	const readWorktreeRun = (run: FakeRun, projects: CrewProject[], now: number) => [
		...run.kept,
		...readRun(run, projects, runMs, now),
	];

	// A runner's verdict lands on the worktree, as crew records health.
	const settle = (machine: FakeMachine, worktree: FakeWorktree, now: number) => {
		if (!worktree.run || now - worktree.run.startedAt < runMs) {
			return;
		}

		const statuses = readWorktreeRun(worktree.run, machine.projects, now);
		worktree.issues = statuses.flatMap((status) => status.issues);
	};

	const run = (machineId: string, command: SetupCommand): SetupReply => {
		const machine = machines[machineId];
		const failure = failing.get(machineId);

		if (!machine) {
			return { kind: 'failed', reason: 'unknown_machine', error: `no machine ${machineId}` };
		}

		// Worded as the link words them (remote/link.ts).
		if (failure) {
			return failure.reason === 'remote_outdated'
				? {
						kind: 'failed',
						reason: failure.reason,
						error: `${machineId} runs an older crew that cannot do this yet — it updates from this Mac`,
						...(failure.version ? { version: failure.version } : {}),
					}
				: { kind: 'failed', reason: failure.reason, error: `${machineId} is out of reach` };
		}

		const now = clock();
		const findProject = (name: string) => machine.projects.find((project) => project.name === name);
		const findWorkspace = (name: string) =>
			machine.workspaces.find((workspace) => workspace.name === name);
		const findWorktree = (ref: string) =>
			machine.worktrees.find((worktree) => worktree.ref === ref);

		for (const worktree of machine.worktrees) {
			settle(machine, worktree, now);
		}

		const addWorktree = (ref: string, workspace: FakeWorkspace) => {
			const worktree: FakeWorktree = {
				ref,
				devRunning: false,
				sizeBytes: 104_857_600,
				overrides: {},
				issues: [],
				run: startRun(workspace.projects.map((project) => project.name)),
			};

			machine.worktrees.push(worktree);
			workspace.worktrees.push(ref.split('/')[1] ?? ref);

			return worktree;
		};

		// transfer.PlanRows over this machine: a project here by name is kept (same remote) or another
		// repo; a new one clones into crew's projects folder unless that is taken or it has no remote.
		const planRows = (bundle: FakeBundle): PlanRow[] => [
			...bundle.projects.map((entry): PlanRow => {
				const here = findProject(entry.name);
				const row = { kind: 'project' as const, name: entry.name };

				if (here) {
					return !entry.remote || !here.remote || here.remote === entry.remote
						? { ...row, status: 'exists', detail: here.path }
						: { ...row, status: 'other remote', detail: `local ${here.remote || 'no remote'}` };
				}

				if (!entry.remote) {
					return { ...row, status: 'missing', detail: 'no git remote — --path=<dir>' };
				}

				return machine.projects.some((project) => project.path === clonePath(entry.name))
					? {
							...row,
							status: 'blocked',
							detail: `${clonePath(entry.name)} exists — --path=${clonePath(entry.name)} adopts it, or delete it`,
						}
					: { ...row, status: 'clone', detail: clonePath(entry.name) };
			}),
			...bundle.workspaces.map((membership): PlanRow => {
				const row = { kind: 'workspace' as const, name: membership.name };
				const needs = membership.projects
					.map((member) => member.name)
					.filter((name) => !findProject(name));

				return findWorkspace(membership.name)
					? { ...row, status: 'exists' }
					: needs.length
						? { ...row, status: 'needs', detail: needs.join(', ') }
						: { ...row, status: 'ready' };
			}),
		];

		const importProject = (
			entry: FakeBundle['projects'][number],
			options: {
				path?: string;
				replace?: boolean;
				rename?: string;
				setup?: string;
				env_cmd?: string;
			},
		): { row: PlanRow } | { error: string } => {
			const name = options.rename ?? entry.name;
			const here = findProject(name);

			if (here && !options.replace) {
				return { error: LINES.import_collision?.replace('store-api', name) ?? `${name} exists` };
			}

			if (!entry.remote && !options.path && !here) {
				return { error: `${name} has no git remote — --path=<dir>` };
			}

			const { remote = '', ...config } = entry;
			const path = options.path ?? here?.path ?? clonePath(name);
			const project: CrewProject = {
				...config,
				name,
				path,
				remote: here?.remote ?? remote,
				...(options.setup ? { setup: options.setup } : {}),
				...(options.env_cmd ? { env_cmd: options.env_cmd } : {}),
			};
			const isCloned = !options.path && !here;
			machine.projects = [...machine.projects.filter((other) => other.name !== name), project];

			return {
				row: {
					kind: 'project',
					name,
					status: here ? 'replaced' : isCloned ? 'imported (cloned)' : 'imported',
					detail: path,
				},
			};
		};

		const importWorkspace = (
			membership: FakeBundle['workspaces'][number],
		): { row: PlanRow } | { error: string } => {
			const needs = membership.projects.filter((member) => !findProject(member.name));

			if (needs.length) {
				return {
					error: `workspace ${membership.name} needs ${needs.map((member) => member.name).join(', ')} first`,
				};
			}

			if (findWorkspace(membership.name)) {
				return { error: `workspace '${membership.name}' exists` };
			}

			const workspace: FakeWorkspace = {
				name: membership.name,
				projects: membership.projects.map((member) => ({ ...member })),
				worktrees: [],
			};
			machine.workspaces.push(workspace);
			addWorktree(`${membership.name}/main`, workspace);

			return {
				row: {
					kind: 'workspace',
					name: membership.name,
					status: 'created',
					detail: `installing — crew setup status ${membership.name}/main`,
				},
			};
		};

		switch (command.type) {
			case 'ls_projects':
				return json(machine.projects);
			case 'ls_workspaces':
				return json(
					machine.workspaces.map((workspace) => {
						const members = workspace.projects.map((project) => project.name);

						return {
							name: workspace.name,
							project_count: workspace.projects.length,
							projects: workspace.projects,
							worktrees: workspace.worktrees,
							dev_running: machine.worktrees.some(
								(worktree) => worktree.ref.startsWith(`${workspace.name}/`) && worktree.devRunning,
							),
							wires: machine.projects
								.filter((project) => members.includes(project.name))
								.flatMap((project) =>
									(project.bindings ?? []).flatMap((binding) => {
										const to = /\{\{\s*([^}./\s]+)/.exec(binding.value)?.[1];

										return to
											? [{ var: binding.var, from: project.name, to, ok: members.includes(to) }]
											: [];
									}),
								),
						};
					}),
				);
			case 'ls_worktrees': {
				const rows = machine.worktrees
					.filter(
						(worktree) => !command.workspace || worktree.ref.startsWith(`${command.workspace}/`),
					)
					.map((worktree) => {
						const isInstalling = worktree.run !== null && now - worktree.run.startedAt < runMs;

						return {
							ref: worktree.ref,
							path: `/w/${worktree.ref}`,
							dev_running: worktree.devRunning,
							installing: isInstalling,
							...(command.size ? { size_bytes: worktree.sizeBytes } : {}),
							...(worktree.issues.length
								? {
										health: `${worktree.issues.length} ${worktree.issues.length === 1 ? 'issue' : 'issues'}`,
										issues: worktree.issues,
									}
								: {}),
						};
					});
				const checks = Object.entries(machine.checks).flatMap(([project, check]) => {
					const status = readRun(check, machine.projects, runMs, now)[0];

					return status?.state === 'failed'
						? [
								{
									ref: `check/${project}`,
									path: `/w/check/${project}`,
									dev_running: false,
									installing: false,
									health: `install failed: ${project}`,
									issues: status.issues,
								},
							]
						: [];
				});

				return json(command.workspace ? rows : [...rows, ...checks]);
			}
			case 'show': {
				const [workspaceName = ''] = command.ref.split('/');
				const workspace = findWorkspace(workspaceName);

				return workspace
					? json(
							workspace.projects.map((project) => ({
								name: project.name,
								path: `/w/${command.ref}/${project.name}`,
								mode: project.mode,
							})),
						)
					: refuse(`no worktree ${command.ref}`);
			}
			case 'ls_overrides':
				return json(findWorktree(command.ref)?.overrides ?? {});
			case 'ls_bindings':
				return json(readGolden('ls-bindings.json'));
			case 'ls_bindings_preview':
				return json(readGolden('ls-bindings-preview.json'));
			case 'ls_bases': {
				const workspace = findWorkspace(command.workspace);

				// A project with no remote cannot be fetched: crew says so instead of a count.
				return json(
					(workspace?.projects ?? []).map((member, index) =>
						findProject(member.name)?.remote
							? {
									project: member.name,
									base: 'main',
									current: 'main',
									behind: index === 0 ? 3 : 0,
									ahead: 0,
								}
							: {
									project: member.name,
									base: 'main',
									current: 'main',
									behind: -1,
									ahead: 0,
									error: 'fetch failed: no remote',
								},
					),
				);
			}
			case 'scan_checkouts':
				return json(
					machine.scan.map((row) => ({
						...row,
						known: row.known || machine.projects.some((project) => project.path === row.path),
					})),
				);
			case 'setup_status': {
				if (command.ref.startsWith('check/')) {
					const check = machine.checks[command.ref.slice('check/'.length)];
					const { doc, code } = toStatus(
						command.ref,
						check ? readRun(check, machine.projects, runMs, now) : [],
						now,
					);

					return json(doc, code);
				}

				const worktree = findWorktree(command.ref);
				const { doc, code } = toStatus(
					command.ref,
					worktree?.run ? readWorktreeRun(worktree.run, machine.projects, now) : [],
					now,
				);

				return json(doc, code);
			}
			case 'check_status': {
				const check = machine.checks[command.project];

				if (!check) {
					return json({
						project: command.project,
						state: 'none',
						smoked: false,
						health: null,
						projects: [],
					});
				}

				const [status] = readRun(check, machine.projects, runMs, now);
				const state =
					status?.state === 'running'
						? 'running'
						: status?.state === 'failed'
							? 'failed'
							: 'passed';

				return json({
					project: command.project,
					state,
					...(state === 'running'
						? {}
						: { verdict: state, at: new Date(check.startedAt + runMs).toISOString() }),
					smoked: state === 'passed',
					health: status?.issues.length
						? { at: new Date(now).toISOString(), issues: status.issues }
						: null,
					// A failed check's runner result is gone once crew keeps its target; health says why.
					projects: status && state !== 'failed' ? [status] : [],
				});
			}
			case 'setup_logs':
				return json(readGolden('setup-logs.json'));
			case 'dev_logs':
				return json({
					ref: command.ref,
					server: command.server,
					lines: [`$ ${command.server}`, 'listening', 'GET / 200 4 ms'],
				});
			case 'dev_status':
				return json(
					readGolden<{ worktree: string }[]>('dev-status.json').filter(
						(row) => !command.ref || row.worktree === command.ref,
					),
				);
			case 'dev_check':
				return json(readGolden('dev-check.json'));
			case 'env':
				return json(readGolden('env.json'));
			case 'add_binding_scan':
				return json(readGolden('add-binding-scan.json'));
			case 'add_binding_dry_run':
				return command.value.includes('.foo')
					? json(readGolden('add-binding-dry-run-error.json'), 1)
					: json({
							...readGolden<object>('add-binding-dry-run.json'),
							var: command.var,
							server: command.server ?? '',
							value: command.value,
						});
			case 'rm_worktree_dry_run': {
				const [workspaceName = ''] = command.ref.split('/');
				const workspace = findWorkspace(workspaceName);
				const isLast = (workspace?.worktrees.length ?? 0) <= 1;

				return json(
					readGolden(isLast ? 'rm-worktree-dry-run-last.json' : 'rm-worktree-dry-run.json'),
				);
			}
			case 'rm_workspace_project_dry_run':
				return json(readGolden('rm-workspace-project-dry-run.json'));
			case 'import_plan': {
				const bundle = readBundle(command.bundle);

				return bundle ? json(planRows(bundle)) : refuse(BAD_BUNDLE);
			}
			case 'clean_dry_run':
				return json(machine.cleanDryRun);
			case 'trash':
				return json({
					path: '/Users/dev/.crew/trash',
					bytes: machine.trashBytes,
					entries: machine.trashBytes ? 3 : 0,
				});
			case 'config_show':
				return json(readGolden('config-show.json'));
			case 'proxy_status':
				return json(readGolden('proxy-status.json'));
			case 'update_check':
				return json(readGolden('update-check.json'));
			case 'server_status':
				return json(readGolden('server-status.json'));
			case 'machines_ls':
				return json(machine.voiceMachines);
			case 'keys_status':
				return json(readGolden('server-keys.json'));
			case 'discord_status':
				return json(
					readGolden(
						machine.isDiscordSetUp ? 'server-discord-status.json' : 'server-discord-off.json',
					),
				);
			case 'discord_channels':
				return machine.isDiscordSetUp
					? json(readGolden('server-discord-channels.json'))
					: refuse('Error: Discord is not set up here — crew server discord setup');
			case 'migrate_dry_run':
				// Under --json the moves are the document; the plan text is crew's narration.
				return json(
					machine.flatWorkspaces.map((name) => ({ workspace: name, ref: `${name}/main` })),
					0,
					machine.flatWorkspaces
						.map((name) => `${name}: ~/.crew/workspaces/${name} → ${name}/main\n`)
						.join(''),
				);
			case 'migrate': {
				const migrated = machine.flatWorkspaces.length;
				machine.flatWorkspaces = [];

				return json({ migrated }, 0, `Migrated ${migrated} workspaces.\n`);
			}
			case 'proxy_trust':
				return json({
					domain: '192.168.1.20.nip.io',
					ca: '/Users/dev/.crew/tls/192.168.1.20.nip.io/ca.pem',
					fingerprint: 'AB:CD:EF:01',
					pem_url: 'http://192.168.1.20/crew-ca.pem',
					https_port: 443,
					server_ip_set: true,
				});
			case 'machines_rm': {
				if (!machine.voiceMachines.some((row) => row.id === command.id)) {
					return refuse(`no machine '${command.id}'`);
				}

				machine.voiceMachines = machine.voiceMachines.filter((row) => row.id !== command.id);

				return json({ removed: command.id });
			}
			case 'machines_rename': {
				const row = machine.voiceMachines.find((candidate) => candidate.id === command.id);

				if (!row) {
					return refuse(`no machine '${command.id}'`);
				}

				row.name = command.name;

				return json({ renamed: command.id, name: command.name });
			}
			case 'debug_tail':
				return ok('10:41:02 git worktree add …\n10:41:09 tmux new-window …\n');

			case 'add_project': {
				const name =
					command.name ??
					command.url
						?.split('/')
						.at(-1)
						?.replace(/\.git$/, '') ??
					'';

				if (findProject(name)) {
					return refuse(
						LINES.import_collision?.replace('store-api', name) ?? `project '${name}' exists`,
					);
				}

				machine.projects.push({
					name,
					path: command.path ?? `/Users/dev/.crew/projects/${name}`,
					remote:
						command.url ?? machine.scan.find((row) => row.path === command.path)?.remote ?? '',
					...(command.setup ? { setup: command.setup } : {}),
				});

				return said(`Added project ${name}`);
			}
			case 'update_project': {
				const project = findProject(command.name);

				if (!project) {
					return refuse(`no project '${command.name}'`);
				}

				if (command.setup !== undefined) {
					project.setup = command.setup;
				}

				if (command.env_cmd !== undefined) {
					project.env_cmd = command.env_cmd;
				}

				return said(`Setup for ${command.name}: ${project.setup ?? ''}`);
			}
			case 'rm_project':
				if (
					machine.workspaces.some((workspace) =>
						workspace.projects.some((project) => project.name === command.name),
					)
				) {
					return refuse(
						`project '${command.name}' is still in a workspace — crew rm workspace <ws> ${command.name} first`,
					);
				}

				machine.projects = machine.projects.filter((project) => project.name !== command.name);

				return said(`clone at ~/.crew/projects/${command.name} moved to the trash`);
			case 'dev_add': {
				const project = findProject(command.project);

				if (!project) {
					return refuse(`no project '${command.project}'`);
				}

				const servers = (project.dev_servers ?? []).filter(
					(server) => server.name !== (command.rename ?? command.name),
				);
				const before = (project.dev_servers ?? []).find(
					(server) => server.name === (command.rename ?? command.name),
				);
				const server = {
					name: command.name,
					command: command.cmd ?? before?.command ?? '',
					// As crew: an edit keeps what it was not given; --port=0 clears it.
					...((command.port ?? (command.rename ? before?.port : undefined))
						? { port: command.port ?? before?.port }
						: {}),
					...(command.dir ? { dir: command.dir } : {}),
				};

				project.dev_servers = [...servers, server];

				if (command.rename) {
					project.bindings = project.bindings?.map((binding) =>
						binding.server === command.rename ? { ...binding, server: command.name } : binding,
					);
				}

				return said(
					command.rename
						? `Renamed dev server '${command.rename}' → '${command.name}' in ${command.project}`
						: `Added dev server '${command.name}' to ${command.project}`,
				);
			}
			case 'dev_rm': {
				const project = findProject(command.project);

				if (!project) {
					return refuse(`no project '${command.project}'`);
				}

				project.dev_servers = (project.dev_servers ?? []).filter(
					(server) => server.name !== command.server,
				);

				return said(`Removed dev server '${command.server}' from ${command.project}`);
			}
			case 'add_binding': {
				const project = findProject(command.project);

				if (!project) {
					return refuse(`no project '${command.project}'`);
				}

				project.bindings = [
					...(project.bindings ?? []).filter(
						(binding) =>
							!(binding.var === command.var && (binding.server ?? '') === (command.server ?? '')),
					),
					{
						var: command.var,
						value: command.value,
						...(command.server ? { server: command.server } : {}),
					},
				];

				return said(`Bound ${command.var} for ${command.project}`);
			}
			case 'add_binding_scan_apply':
				return json(readGolden('add-binding-scan-apply.json'));
			case 'rm_binding': {
				const project = findProject(command.project);

				if (project) {
					project.bindings = (project.bindings ?? []).filter(
						(binding) =>
							!(binding.var === command.var && (binding.server ?? '') === (command.server ?? '')),
					);
				}

				return said(`Removed binding ${command.var} from ${command.project}`);
			}
			case 'check_project':
				if (!findProject(command.project)) {
					return refuse(`no project '${command.project}'`);
				}

				machine.checks[command.project] = startRun([command.project]);

				return said(`Checking ${command.project}`);
			case 'add_workspace': {
				const missing = command.projects.find((name) => !findProject(name));

				if (missing) {
					return refuse(`no project '${missing}'`);
				}

				const existing = findWorkspace(command.name);
				const mode = command.direct ? 'direct' : 'worktree';

				if (existing) {
					const member = command.projects.find((name) =>
						existing.projects.some((project) => project.name === name),
					);

					if (member) {
						return refuse(`project '${member}' already in workspace`);
					}

					existing.projects.push(...command.projects.map((name) => ({ name, mode })));

					return said(`Added ${command.projects.join(', ')} to ${command.name}`);
				}

				const workspace: FakeWorkspace = {
					name: command.name,
					projects: command.projects.map((name) => ({ name, mode })),
					worktrees: [],
				};
				machine.workspaces.push(workspace);

				if (command.projects.length) {
					addWorktree(`${command.name}/main`, workspace);
				}

				return said(`Created workspace ${command.name}`);
			}
			case 'rm_workspace_project': {
				const workspace = findWorkspace(command.workspace);

				if (workspace) {
					workspace.projects = workspace.projects.filter(
						(project) => project.name !== command.project,
					);
				}

				return said(`Removed ${command.project} from ${command.workspace}'s worktrees`);
			}
			case 'rm_workspace':
				machine.workspaces = machine.workspaces.filter(
					(workspace) => workspace.name !== command.workspace,
				);
				machine.worktrees = machine.worktrees.filter(
					(worktree) => !worktree.ref.startsWith(`${command.workspace}/`),
				);

				return said(`Removed workspace ${command.workspace}`);
			case 'add_worktree': {
				const [workspaceName = ''] = command.ref.split('/');
				const workspace = findWorkspace(workspaceName);

				if (!workspace) {
					return refuse(`no workspace '${workspaceName}'`);
				}

				addWorktree(command.ref, workspace);

				return said(`Created ${command.ref}`);
			}
			case 'rm_worktree': {
				const [workspaceName = '', name] = command.ref.split('/');
				const workspace = findWorkspace(workspaceName);

				machine.worktrees = machine.worktrees.filter((worktree) => worktree.ref !== command.ref);

				if (workspace) {
					workspace.worktrees = workspace.worktrees.filter((other) => other !== name);
				}

				machine.trashBytes += 524_288_000;

				return said(`Removed ${command.ref}: checkouts moved to the trash`);
			}
			case 'rename_worktree': {
				const worktree = findWorktree(command.ref);
				const [workspaceName = '', name] = command.ref.split('/');

				if (!worktree) {
					return refuse(`no worktree ${command.ref}`);
				}

				if (worktree.devRunning) {
					return refuse(`${command.ref}: its servers run — crew dev stop ${command.ref} first`);
				}

				worktree.ref = `${workspaceName}/${command.name}`;
				const workspace = findWorkspace(workspaceName);

				if (workspace) {
					workspace.worktrees = workspace.worktrees.map((other) =>
						other === name ? command.name : other,
					);
				}

				return said(`Renamed ${command.ref} → ${worktree.ref}`);
			}
			case 'duplicate_worktree': {
				const [workspaceName = ''] = command.ref.split('/');
				const workspace = findWorkspace(workspaceName);

				if (!workspace) {
					return refuse(`no workspace '${workspaceName}'`);
				}

				const copy = addWorktree(`${workspaceName}/${command.name}`, workspace);
				copy.overrides = { ...(findWorktree(command.ref)?.overrides ?? {}) };

				return said(`Duplicated ${command.ref} as ${copy.ref}`);
			}
			case 'add_override': {
				const worktree = findWorktree(command.ref);

				if (worktree) {
					worktree.overrides[command.var] = command.value;
				}

				return said(`Pinned ${command.var} in ${command.ref}`);
			}
			case 'rm_override': {
				const worktree = findWorktree(command.ref);

				if (worktree) {
					delete worktree.overrides[command.var];
				}

				return said(`Removed ${command.var} from ${command.ref}`);
			}
			case 'setup_rerun':
			case 'verify': {
				const worktree = findWorktree(command.ref);

				if (!worktree) {
					return refuse(`no worktree ${command.ref}`);
				}

				const [workspaceName = ''] = command.ref.split('/');
				const members = findWorkspace(workspaceName)?.projects.map((project) => project.name) ?? [];
				const projects = command.projects?.length ? command.projects : members;
				const before = worktree.run ? readWorktreeRun(worktree.run, machine.projects, clock()) : [];
				worktree.run = {
					...startRun(projects),
					kept: before.filter((status) => !projects.includes(status.project)),
				};
				worktree.issues = worktree.run.kept.flatMap((status) => status.issues);

				return said(`${command.type === 'verify' ? 'Verifying' : 'Setting up'} ${command.ref}`);
			}
			case 'dev_start':
			case 'dev_restart': {
				const worktree = findWorktree(command.ref);

				if (worktree) {
					worktree.devRunning = true;
				}

				return said(`Started ${command.ref}`);
			}
			case 'dev_stop':
				for (const worktree of machine.worktrees) {
					if (!command.ref || worktree.ref === command.ref) {
						worktree.devRunning = false;
					}
				}

				return said(`Stopped ${command.ref ?? 'every worktree'}`);
			case 'import_project': {
				const bundle = readBundle(command.bundle);
				const entry = bundle?.projects.find((project) => project.name === command.name);

				if (!bundle || !entry) {
					return refuse(bundle ? `no project '${command.name}' in the export` : BAD_BUNDLE);
				}

				const result = importProject(entry, command);

				return 'error' in result ? refuse(result.error) : json([result.row]);
			}
			case 'import_workspace': {
				const bundle = readBundle(command.bundle);
				const membership = bundle?.workspaces.find((workspace) => workspace.name === command.name);

				if (!bundle || !membership) {
					return refuse(bundle ? `no workspace '${command.name}' in the export` : BAD_BUNDLE);
				}

				const result = importWorkspace(membership);

				return 'error' in result ? refuse(result.error) : json([result.row]);
			}
			case 'import_all': {
				const bundle = readBundle(command.bundle);

				if (!bundle) {
					return refuse(BAD_BUNDLE);
				}

				const refused = planRows(bundle).filter(
					(row) => row.status === 'blocked' || row.status === 'missing',
				);

				if (refused.length) {
					return refuse(
						`these cannot go as they are; import them one by one: ${refused.map((row) => row.name).join(', ')}`,
					);
				}

				const rows = [
					...bundle.projects.flatMap((entry) => {
						if (findProject(entry.name) && !command.replace) {
							return [];
						}

						const result = importProject(entry, { replace: command.replace });

						return 'row' in result ? [result.row] : [];
					}),
					...bundle.workspaces.flatMap((membership) => {
						const result = findWorkspace(membership.name) ? null : importWorkspace(membership);

						return result && 'row' in result ? [result.row] : [];
					}),
				];

				return json(rows);
			}
			case 'trash_empty':
				machine.trashBytes = 0;

				return json(readGolden('trash-empty.json'));
			case 'clean':
				return json(readGolden('clean-dry-run.json'));
			case 'config_set':
				return said(`Set ${command.key}`);
			case 'config_refresh':
				return said('tmux config rewritten');
			case 'keys_set':
				return command.value.startsWith('sk-ant-') || command.name === 'soniox'
					? json({ ...readGolden<object>('server-keys-set.json'), saved: command.name })
					: {
							kind: 'ran',
							result: {
								code: 1,
								stdout: '',
								stderr: `${LINES.key_rejected?.replace('Soniox', 'Anthropic') ?? 'rejected'}\n`,
							},
						};
			case 'update':
				return json(readGolden('update.json'), 0, 'crew updated to v4.2.0\n');
			case 'server_restart':
			case 'server_stop':
			case 'uninstall':
				return { kind: 'started' };
			case 'machines_add': {
				const added = {
					id: command.host.replace(/^.*@/, '').split('.')[0] ?? command.host,
					host: command.host,
					name: command.name ?? command.host,
				};
				machine.voiceMachines.push(added);

				return json(added, 0, `Added ${added.name} (${added.host}).\n`);
			}
			case 'discord_off':
				machine.isDiscordSetUp = false;

				return json({ removed: ['discord.json', 'discord.key'] });
			case 'discord_text_channel':
				return json(
					readGolden('server-discord-setup.json'),
					0,
					command.channel === 'voice'
						? "messages: the voice channel's chat\n"
						: `messages: #${command.channel}\n`,
				);
			case 'export': {
				const projects = command.all
					? machine.projects
					: machine.projects.filter((project) => command.projects?.includes(project.name));
				const workspaces = command.all
					? machine.workspaces
					: machine.workspaces.filter((workspace) => command.workspaces?.includes(workspace.name));
				const short = workspaces.find((workspace) =>
					workspace.projects.some(
						(member) => !projects.some((project) => project.name === member.name),
					),
				);

				if (short) {
					return refuse(`workspace ${short.name} needs its projects — add them to --projects`);
				}

				const bundle: FakeBundle = {
					version: 2,
					projects: projects.map(({ path: _path, remote, ...rest }) => ({
						...rest,
						...(remote ? { remote } : {}),
					})),
					workspaces: workspaces.map(({ name, projects: members }) => ({
						name,
						projects: members,
					})),
				};

				return ok(
					`${JSON.stringify(bundle, null, 2)}\n`,
					`Wrote the bundle to stdout — ${plural(projects.length, 'project')}, ${plural(workspaces.length, 'workspace')}\n`,
				);
			}
			// No TS reader: crew's goldens for these are Go-only.
			case 'fix':
			case 'doctor':
				return {
					kind: 'ran',
					result: { code: 2, stdout: '', stderr: `fake crew: unhandled ${command.type}\n` },
				};

			default: {
				const unreachable: never = command;

				return {
					kind: 'ran',
					result: { code: 2, stdout: '', stderr: `fake crew: unhandled ${String(unreachable)}\n` },
				};
			}
		}
	};

	// Without --json crew narrates on stdout: a command that runs without it says its line there.
	const asCrewPrints = (command: SetupCommand, reply: SetupReply): SetupReply =>
		reply.kind === 'ran' &&
		reply.result.code === 0 &&
		!traitsOf(command).json &&
		reply.result.stdout === ''
			? { kind: 'ran', result: { ...reply.result, stdout: reply.result.stderr, stderr: '' } }
			: reply;

	return {
		runCrew: async (machine, command) => {
			calls.push({ machine, command });

			return asCrewPrints(command, run(machine, command));
		},
		machines,
		calls,
		failInstall: (project) => failNext.add(project),
		failMachine: (id, failure) => {
			if (failure) {
				failing.set(id, failure);
			} else {
				failing.delete(id);
			}
		},
		reset,
	};
};
