// Everything the Set up page asks crew, as one typed union. The page sends a SetupCommand, never
// argv: the server (or a remote, for its own machine) validates it with this schema and builds the
// argv with toCrewArgv, so nothing the browser types reaches crew as a flag or a second command.
// Browser-safe on purpose (zod only): the page imports it for the CommandLine shown on every form.

import { MAX_NAME_LENGTH } from '../state/names.js';
import { z } from 'zod';

const MINUTE = 60_000;
const READ_MS = 30_000;
const WRITE_MS = 2 * MINUTE;
const LONG_MS = 10 * MINUTE;

// A positional argument: never empty, never a flag, never a second line.
const word = z
	.string()
	.min(1)
	.max(500)
	.refine((value) => !value.startsWith('-') && !/[\0\n\r]/.test(value), 'not a plain argument');

// A flag's value: may be empty (an empty --setup= clears it) but never a second line.
const flagValue = z
	.string()
	.max(4000)
	.refine((value) => !/[\0\n\r]/.test(value), 'one line only');

const lines = z.number().int().min(1).max(1000);
// crew dev add --port=0: a server that does not listen — how a rename clears the port it had.
const serverPort = z.number().int().min(0).max(65_535);
const confirm = z.literal(true);
// A bundle or a key travels on stdin, never in argv (process lists) or logs.
const stdinText = z.string().min(1).max(5_000_000);

const variant = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
	z.strictObject({ type: z.literal(type), ...shape });

const importRun = {
	bundle: stdinText,
	pull: z.boolean().optional(),
	no_install: z.boolean().optional(),
	no_smoke: z.boolean().optional(),
};

export const SetupCommandSchema = z.discriminatedUnion('type', [
	// Reads.
	variant('ls_projects', {}),
	variant('ls_workspaces', {}),
	variant('ls_worktrees', { workspace: word.optional(), size: z.boolean().optional() }),
	variant('ls_bindings', { project: word, check: word.optional() }),
	variant('ls_bindings_preview', { project: word }),
	variant('ls_overrides', { ref: word }),
	variant('ls_bases', { workspace: word }),
	variant('show', { ref: word }),
	variant('scan_checkouts', {}),
	variant('setup_status', { ref: word }),
	variant('setup_logs', { ref: word, project: word, lines: lines.optional() }),
	variant('check_status', { project: word }),
	variant('dev_status', { ref: word.optional() }),
	variant('dev_check', { ref: word }),
	variant('dev_logs', { ref: word, server: word, lines: lines.optional() }),
	variant('env', { ref: word, project: word, server: word.optional() }),
	variant('fix', { ref: word }),
	variant('import_plan', { bundle: stdinText }),
	variant('export', {
		all: z.boolean().optional(),
		projects: z.array(word).optional(),
		workspaces: z.array(word).optional(),
	}),
	variant('clean_dry_run', {}),
	variant('trash', {}),
	variant('config_show', {}),
	variant('proxy_status', {}),
	variant('update_check', {}),
	variant('server_status', {}),
	variant('machines_ls', {}),
	variant('keys_status', {}),
	variant('discord_status', {}),
	variant('ls_chats', {}),
	variant('discord_channels', {}),
	variant('debug_tail', { lines: lines.optional() }),
	variant('doctor', {}),
	variant('migrate_dry_run', {}),
	variant('rm_workspace_project_dry_run', { workspace: word, project: word }),
	variant('rm_worktree_dry_run', { ref: word }),
	variant('add_binding_dry_run', {
		project: word,
		server: word.optional(),
		var: word,
		value: flagValue,
	}),
	variant('add_binding_scan', { project: word }),

	// Projects.
	variant('add_project', {
		name: word.optional(),
		url: word.optional(),
		path: word.optional(),
		setup: flagValue.optional(),
		env_cmd: flagValue.optional(),
	}),
	variant('update_project', {
		name: word,
		setup: flagValue.optional(),
		env_cmd: flagValue.optional(),
	}),
	variant('rm_project', { name: word, keep_clone: z.boolean().optional(), confirm }),
	variant('dev_add', {
		project: word,
		name: word,
		rename: word.optional(),
		port: serverPort.optional(),
		cmd: flagValue.optional(),
		dir: flagValue.optional(),
	}),
	variant('dev_rm', { project: word, server: word }),
	variant('add_binding', { project: word, server: word.optional(), var: word, value: flagValue }),
	variant('add_binding_scan_apply', { project: word }),
	variant('rm_binding', { project: word, server: word.optional(), var: word }),
	variant('check_project', {
		project: word,
		pull: z.boolean().optional(),
		no_smoke: z.boolean().optional(),
	}),

	// Workspaces and worktrees.
	variant('add_workspace', {
		name: word,
		projects: z.array(word),
		direct: z.boolean().optional(),
	}),
	variant('rm_workspace_project', { workspace: word, project: word, confirm }),
	variant('rm_workspace', { workspace: word, confirm }),
	variant('add_worktree', {
		ref: word,
		pull: z.boolean().optional(),
		no_install: z.boolean().optional(),
		no_smoke: z.boolean().optional(),
	}),
	variant('rm_worktree', { ref: word, confirm }),
	variant('rename_worktree', { ref: word, name: word }),
	variant('duplicate_worktree', { ref: word, name: word }),
	variant('add_override', { ref: word, var: word, value: flagValue }),
	variant('rm_override', { ref: word, var: word }),
	variant('setup_rerun', {
		ref: word,
		projects: z.array(word).optional(),
		no_smoke: z.boolean().optional(),
	}),
	variant('verify', { ref: word, projects: z.array(word).optional() }),
	variant('dev_start', { ref: word, proxy: z.boolean().optional() }),
	variant('dev_stop', { ref: word.optional() }),
	variant('dev_restart', { ref: word, proxy: z.boolean().optional() }),

	// Moving between machines.
	variant('import_project', {
		...importRun,
		name: word,
		path: word.optional(),
		replace: z.boolean().optional(),
		rename: word.optional(),
		setup: flagValue.optional(),
		env_cmd: flagValue.optional(),
		confirm: confirm.optional(),
	}),
	variant('import_workspace', { ...importRun, name: word }),
	variant('import_all', {
		...importRun,
		replace: z.boolean().optional(),
		confirm: confirm.optional(),
	}),

	// Housekeeping and settings.
	variant('clean', { confirm }),
	variant('trash_empty', { confirm }),
	// The value goes as a positional: one starting with '-' would reach crew as a flag.
	variant('config_set', {
		key: word,
		value: flagValue.refine((value) => !value.startsWith('-'), 'not a plain argument'),
	}),
	variant('config_refresh', {}),
	variant('proxy_trust', {}),
	variant('migrate', { confirm }),
	variant('update', {}),
	variant('server_restart', {}),
	variant('server_stop', { confirm }),
	variant('uninstall', { mode: z.enum(['keep', 'purge']), confirm }),
	variant('machines_add', { host: word, name: word.optional() }),
	variant('machines_rm', { id: word, confirm }),
	variant('machines_rename', { id: word, name: word }),
	variant('keys_set', { name: z.enum(['anthropic', 'soniox']), value: stdinText }),
	variant('discord_off', {}),
	// A plain Claude session (crew chat): a folder on that machine, a name.
	variant('chat_add', {
		dir: flagValue.pipe(z.string().trim().min(1)).optional(),
		name: flagValue.pipe(z.string().trim().min(1).max(MAX_NAME_LENGTH)).optional(),
	}),
	variant('chat_rm', { id: z.string().regex(/^(?:chat\/)?[0-9a-f]{6}$/) }),
	// A channel's id, or voice: back to the voice channel's own chat.
	variant('discord_text_channel', { channel: word }),
]);

export type SetupCommand = z.infer<typeof SetupCommandSchema>;
export type SetupCommandType = SetupCommand['type'];

// What the schema cannot say field by field: a replace overwrites a project here with the bundle's
// (the same confirm as a removal); a new project comes from one source, by name or url.
const crossFieldRefusal = (command: SetupCommand): string | null => {
	if (command.type === 'import_project' || command.type === 'import_all') {
		return command.replace && !command.confirm ? 'replace needs confirm' : null;
	}

	if (command.type === 'add_project') {
		if (command.url && command.path) {
			return 'url and path: one or the other';
		}

		return command.name || command.url ? null : 'a name or a url';
	}

	return null;
};

export type ParsedSetupCommand = { ok: true; command: SetupCommand } | { ok: false; error: string };

// Never echoes the input: the error names the fields that failed, not their values.
export const parseSetupCommand = (input: unknown): ParsedSetupCommand => {
	const parsed = SetupCommandSchema.safeParse(input);

	if (!parsed.success) {
		const fields = parsed.error.issues.map((issue) => issue.path.join('.') || 'type');

		return { ok: false, error: `invalid command: ${[...new Set(fields)].join(', ')}` };
	}

	const refusal = crossFieldRefusal(parsed.data);

	return refusal ? { ok: false, error: refusal } : { ok: true, command: parsed.data };
};

export interface CommandTraits {
	timeoutMs: number;
	// Never sent to a remote: it would stop, replace or re-key the machine answering the page.
	localOnly: boolean;
	// Replaces the process answering: started, not waited for (the page expects the socket to drop).
	detached: boolean;
	// Appends crew's global --json: the reply's json field is stdout parsed. Only where crew prints a
	// document under --json (every one pinned by a golden or the live spec); a mutation that only
	// narrates runs without it and the page reads its code and crew's line.
	json: boolean;
}

const read: CommandTraits = { timeoutMs: READ_MS, localOnly: false, detached: false, json: true };
const write: CommandTraits = { ...read, timeoutMs: WRITE_MS };
const long: CommandTraits = { ...read, timeoutMs: LONG_MS };
const text: CommandTraits = { ...read, json: false };
const local: CommandTraits = { ...write, localOnly: true };
const said: CommandTraits = { ...write, json: false };
const replacesServer: CommandTraits = { ...local, detached: true, json: false };

export const COMMAND_TRAITS: Record<SetupCommandType, CommandTraits> = {
	ls_projects: read,
	ls_workspaces: read,
	ls_worktrees: read,
	ls_bindings: read,
	ls_bindings_preview: read,
	ls_overrides: read,
	// Fetches every base from origin.
	ls_bases: write,
	show: read,
	scan_checkouts: write,
	setup_status: read,
	setup_logs: read,
	check_status: read,
	dev_status: read,
	dev_check: read,
	dev_logs: read,
	env: read,
	// Without a recorded failure crew runs a full verify first.
	fix: { ...long, json: false },
	import_plan: write,
	export: { ...write, json: false },
	clean_dry_run: write,
	trash: write,
	config_show: read,
	proxy_status: read,
	update_check: read,
	server_status: read,
	machines_ls: { ...read, localOnly: true },
	keys_status: { ...read, localOnly: true },
	discord_status: { ...read, localOnly: true },
	ls_chats: read,
	discord_channels: { ...read, localOnly: true },
	debug_tail: text,
	doctor: read,
	migrate_dry_run: write,
	rm_workspace_project_dry_run: write,
	rm_worktree_dry_run: write,
	add_binding_dry_run: read,
	add_binding_scan: read,
	add_project: { ...long, json: false },
	update_project: said,
	rm_project: said,
	dev_add: said,
	dev_rm: said,
	add_binding: said,
	add_binding_scan_apply: write,
	rm_binding: said,
	check_project: long,
	add_workspace: long,
	rm_workspace_project: said,
	rm_workspace: said,
	add_worktree: long,
	rm_worktree: said,
	rename_worktree: write,
	duplicate_worktree: long,
	add_override: said,
	rm_override: said,
	setup_rerun: write,
	verify: write,
	dev_start: write,
	dev_stop: said,
	dev_restart: write,
	import_project: long,
	import_workspace: long,
	import_all: long,
	clean: long,
	trash_empty: write,
	config_set: said,
	config_refresh: said,
	proxy_trust: write,
	migrate: long,
	update: { ...local, timeoutMs: LONG_MS },
	server_restart: replacesServer,
	server_stop: replacesServer,
	uninstall: replacesServer,
	machines_add: local,
	machines_rm: local,
	machines_rename: local,
	keys_set: local,
	discord_off: local,
	chat_add: write,
	chat_rm: write,
	discord_text_channel: local,
};

export const traitsOf = (command: SetupCommand): CommandTraits => COMMAND_TRAITS[command.type];

const flag = (name: string, value: string | number | undefined): string[] =>
	value === undefined ? [] : [`--${name}=${value}`];

const when = (on: boolean | undefined, ...args: string[]): string[] => (on ? args : []);

const scoped = (project: string, server?: string): string =>
	server ? `${project}/${server}` : project;

const importFlags = (command: {
	pull?: boolean;
	no_install?: boolean;
	no_smoke?: boolean;
}): string[] => [
	...when(command.pull, '--pull'),
	...when(command.no_install, '--no-install'),
	...when(command.no_smoke, '--no-smoke'),
];

// crew's argv without the leading "crew" and without --json (traits say when it is appended).
// Server lifecycle goes through `voice …`, the alias every crew release answers.
const baseArgv = (command: SetupCommand): string[] => {
	switch (command.type) {
		case 'ls_projects':
			return ['ls', 'projects'];
		case 'ls_workspaces':
			return ['ls', 'workspaces'];
		case 'ls_worktrees':
			return [
				'ls',
				'worktrees',
				...(command.workspace ? [command.workspace] : []),
				...when(command.size, '--size'),
			];
		case 'ls_bindings':
			return ['ls', 'bindings', command.project, ...flag('check', command.check)];
		case 'ls_bindings_preview':
			return ['ls', 'bindings', command.project, '--preview'];
		case 'ls_overrides':
			return ['ls', 'overrides', command.ref];
		case 'ls_bases':
			return ['ls', 'bases', command.workspace];
		case 'show':
			return ['show', command.ref];
		case 'scan_checkouts':
			return ['add', 'project', '--scan'];
		case 'setup_status':
			return ['setup', 'status', command.ref];
		case 'setup_logs':
			return ['setup', 'logs', command.ref, command.project, ...flag('lines', command.lines)];
		case 'check_status':
			return ['check', 'project', command.project, '--status'];
		case 'dev_status':
			return ['dev', 'status', ...(command.ref ? [command.ref] : [])];
		case 'dev_check':
			return ['dev', 'check', command.ref];
		case 'dev_logs':
			return ['dev', 'logs', command.ref, command.server, ...flag('lines', command.lines)];
		case 'env':
			return ['env', command.ref, scoped(command.project, command.server)];
		case 'fix':
			return ['fix', command.ref, '--print'];
		case 'import_plan':
			return ['import', '-', '--plan'];
		case 'export':
			return [
				'export',
				...when(command.all, '--all'),
				...(command.projects?.length ? [`--projects=${command.projects.join(',')}`] : []),
				...(command.workspaces?.length ? [`--workspaces=${command.workspaces.join(',')}`] : []),
				'-',
			];
		case 'clean_dry_run':
			return ['clean', '--dry-run'];
		case 'trash':
			return ['trash'];
		case 'config_show':
			return ['config', 'show'];
		case 'proxy_status':
			return ['dev', 'proxy', 'status'];
		case 'update_check':
			return ['update', '--check'];
		case 'server_status':
			return ['voice', 'status'];
		case 'machines_ls':
			return ['voice', 'machines', 'ls'];
		case 'keys_status':
			return ['voice', 'keys', 'status'];
		case 'discord_status':
			return ['voice', 'discord', 'status'];
		case 'ls_chats':
			return ['ls', 'chats'];
		case 'discord_channels':
			return ['voice', 'discord', 'channels'];
		case 'debug_tail':
			return ['debug', ...flag('tail', command.lines ?? 100)];
		case 'doctor':
			return ['doctor'];
		case 'migrate_dry_run':
			return ['migrate', '--dry-run'];
		case 'rm_workspace_project_dry_run':
			return ['rm', 'workspace', command.workspace, command.project, '--dry-run'];
		case 'rm_worktree_dry_run':
			return ['rm', 'worktree', command.ref, '--dry-run'];
		case 'add_binding_dry_run':
			return [
				'add',
				'binding',
				scoped(command.project, command.server),
				`--var=${command.var}`,
				`--value=${command.value}`,
				'--dry-run',
			];
		case 'add_binding_scan':
			return ['add', 'binding', command.project, '--scan'];
		case 'add_project':
			return [
				'add',
				'project',
				...(command.name ? [command.name] : []),
				...(command.url ? [command.url] : []),
				...flag('path', command.path),
				...flag('setup', command.setup),
				...flag('env-cmd', command.env_cmd),
			];
		case 'update_project':
			return [
				'add',
				'project',
				command.name,
				...flag('setup', command.setup),
				...flag('env-cmd', command.env_cmd),
			];
		case 'rm_project':
			return ['rm', 'project', command.name, ...when(command.keep_clone, '--keep-clone')];
		case 'dev_add':
			return [
				'dev',
				'add',
				command.project,
				`--name=${command.name}`,
				...flag('rename', command.rename),
				...flag('port', command.port),
				...flag('cmd', command.cmd),
				...flag('dir', command.dir),
			];
		case 'dev_rm':
			return ['dev', 'rm', command.project, command.server];
		case 'add_binding':
			return [
				'add',
				'binding',
				scoped(command.project, command.server),
				`--var=${command.var}`,
				`--value=${command.value}`,
			];
		case 'add_binding_scan_apply':
			return ['add', 'binding', command.project, '--scan', '--apply'];
		case 'rm_binding':
			return ['rm', 'binding', scoped(command.project, command.server), command.var];
		case 'check_project':
			return [
				'check',
				'project',
				command.project,
				...when(command.pull, '--pull'),
				...when(command.no_smoke, '--no-smoke'),
			];
		case 'add_workspace':
			return [
				'add',
				'workspace',
				command.name,
				...command.projects,
				...when(command.direct, '--direct'),
			];
		case 'rm_workspace_project':
			return ['rm', 'workspace', command.workspace, command.project];
		case 'rm_workspace':
			return ['rm', command.workspace];
		case 'add_worktree':
			return ['add', 'worktree', command.ref, ...importFlags(command)];
		case 'rm_worktree':
			return ['rm', 'worktree', command.ref];
		case 'rename_worktree':
			return ['rename', 'worktree', command.ref, command.name];
		case 'duplicate_worktree':
			return ['duplicate', command.ref, command.name];
		case 'add_override':
			return ['add', 'override', command.ref, `${command.var}=${command.value}`];
		case 'rm_override':
			return ['rm', 'override', command.ref, command.var];
		case 'setup_rerun':
			return [
				'setup',
				command.ref,
				...(command.projects ?? []),
				...when(command.no_smoke, '--no-smoke'),
			];
		case 'verify':
			return ['verify', command.ref, ...(command.projects ?? [])];
		case 'dev_start':
			return ['dev', 'start', command.ref, ...when(command.proxy, '--proxy')];
		case 'dev_stop':
			return ['dev', 'stop', ...(command.ref ? [command.ref] : [])];
		case 'dev_restart':
			return ['dev', 'restart', command.ref, ...when(command.proxy, '--proxy')];
		case 'import_project':
			return [
				'import',
				'-',
				'project',
				command.name,
				...flag('path', command.path),
				...when(command.replace, '--replace'),
				...flag('name', command.rename),
				...flag('setup', command.setup),
				...flag('env-cmd', command.env_cmd),
			];
		case 'import_workspace':
			return ['import', '-', 'workspace', command.name, ...importFlags(command)];
		case 'import_all':
			return [
				'import',
				'-',
				'--all',
				...when(command.replace, '--replace'),
				...importFlags(command),
			];
		case 'clean':
			return ['clean'];
		case 'trash_empty':
			return ['trash', 'empty'];
		case 'config_set':
			return ['config', 'set', command.key, command.value];
		case 'config_refresh':
			return ['config', 'refresh'];
		case 'proxy_trust':
			return ['dev', 'proxy', 'trust'];
		case 'migrate':
			return ['migrate', '--yes'];
		case 'update':
			return ['update'];
		case 'server_restart':
			return ['voice', 'restart', '--no-open'];
		case 'server_stop':
			return ['voice', 'stop'];
		case 'uninstall':
			return ['uninstall', ...when(command.mode === 'purge', '--purge'), '--yes'];
		case 'machines_add':
			return ['voice', 'machines', 'add', command.host, ...flag('name', command.name)];
		case 'machines_rm':
			return ['voice', 'machines', 'rm', command.id];
		case 'machines_rename':
			return ['voice', 'machines', 'rename', command.id, command.name];
		case 'keys_set':
			return ['voice', 'keys', 'set', command.name];
		case 'discord_off':
			return ['voice', 'discord', 'off'];
		case 'chat_add':
			return ['chat', 'add', ...flag('dir', command.dir), ...flag('name', command.name)];
		case 'chat_rm':
			return ['chat', 'rm', command.id];
		case 'discord_text_channel':
			return ['voice', 'discord', 'setup', `--text-channel=${command.channel}`];

		default: {
			const unreachable: never = command;

			throw new Error(`unknown command ${String(unreachable)}`);
		}
	}
};

// Pure: the argv crew runs for a command, --json included where crew answers in JSON.
export const toCrewArgv = (command: SetupCommand): string[] => [
	...baseArgv(command),
	...when(traitsOf(command).json, '--json'),
];

// What goes on crew's stdin: a bundle to import or a key to save — never part of argv.
export const toCrewStdin = (command: SetupCommand): string | undefined => {
	switch (command.type) {
		case 'import_plan':
		case 'import_project':
		case 'import_workspace':
		case 'import_all':
			return command.bundle;
		case 'keys_set':
			return command.value;
		default:
			return undefined;
	}
};
