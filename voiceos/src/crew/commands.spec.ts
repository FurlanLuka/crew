import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	COMMAND_TRAITS,
	SetupCommandSchema,
	parseSetupCommand,
	toCrewArgv,
	toCrewStdin,
	type SetupCommand,
	type SetupCommandType,
} from './commands.js';
import { JSON_EVIDENCE } from '../../test/support/json-evidence.js';

const BUNDLE = '{"version":2,"projects":[]}';

// One sample per variant: the Record makes a new variant without a sample a type error, and the
// shared fixture (walked through crew's help tree by a Go test) is written from it.
const SAMPLES: { [T in SetupCommandType]: Extract<SetupCommand, { type: T }> } = {
	ls_projects: { type: 'ls_projects' },
	ls_workspaces: { type: 'ls_workspaces' },
	ls_worktrees: { type: 'ls_worktrees', workspace: 'store-front', size: true },
	ls_bindings: { type: 'ls_bindings', project: 'store-front', check: 'store-front/main' },
	ls_bindings_preview: { type: 'ls_bindings_preview', project: 'store-front' },
	ls_overrides: { type: 'ls_overrides', ref: 'store-front/main' },
	ls_bases: { type: 'ls_bases', workspace: 'store-front' },
	show: { type: 'show', ref: 'store-front/main' },
	scan_checkouts: { type: 'scan_checkouts' },
	setup_status: { type: 'setup_status', ref: 'store-front/wrk1' },
	setup_logs: { type: 'setup_logs', ref: 'store-front/wrk1', project: 'store-api', lines: 200 },
	check_status: { type: 'check_status', project: 'store-api' },
	dev_status: { type: 'dev_status', ref: 'store-front/main' },
	dev_check: { type: 'dev_check', ref: 'store-front/main' },
	dev_logs: { type: 'dev_logs', ref: 'store-front/main', server: 'web', lines: 100 },
	env: { type: 'env', ref: 'store-front/main', project: 'store-front', server: 'web' },
	fix: { type: 'fix', ref: 'store-front/main' },
	import_plan: { type: 'import_plan', bundle: BUNDLE },
	export: { type: 'export', projects: ['store-front', 'store-api'], workspaces: ['store-front'] },
	clean_dry_run: { type: 'clean_dry_run' },
	trash: { type: 'trash' },
	config_show: { type: 'config_show' },
	proxy_status: { type: 'proxy_status' },
	update_check: { type: 'update_check' },
	server_status: { type: 'server_status' },
	machines_ls: { type: 'machines_ls' },
	keys_status: { type: 'keys_status' },
	discord_status: { type: 'discord_status' },
	debug_tail: { type: 'debug_tail', lines: 50 },
	doctor: { type: 'doctor' },
	migrate_dry_run: { type: 'migrate_dry_run' },
	rm_workspace_project_dry_run: {
		type: 'rm_workspace_project_dry_run',
		workspace: 'store-front',
		project: 'signals',
	},
	rm_worktree_dry_run: { type: 'rm_worktree_dry_run', ref: 'store-front/wrk1' },
	add_binding_dry_run: {
		type: 'add_binding_dry_run',
		project: 'store-front',
		server: 'web',
		var: 'API_URL',
		value: '{{store-api}}',
	},
	add_binding_scan: { type: 'add_binding_scan', project: 'store-front' },
	add_project: {
		type: 'add_project',
		name: 'store-api',
		url: 'git@github.com:acme/store-api.git',
		setup: 'pnpm install',
		env_cmd: 'make env',
	},
	update_project: { type: 'update_project', name: 'store-api', setup: '', env_cmd: 'make env' },
	rm_project: { type: 'rm_project', name: 'signals', keep_clone: true, confirm: true },
	dev_add: {
		type: 'dev_add',
		project: 'store-api',
		name: 'api',
		rename: 'server',
		port: 4000,
		cmd: 'pnpm dev',
		dir: 'apps/api',
	},
	dev_rm: { type: 'dev_rm', project: 'store-api', server: 'worker' },
	add_binding: {
		type: 'add_binding',
		project: 'store-front',
		var: 'API_URL',
		value: '{{store-api/api}}',
	},
	add_binding_scan_apply: { type: 'add_binding_scan_apply', project: 'store-front' },
	rm_binding: { type: 'rm_binding', project: 'store-front', server: 'web', var: 'API_URL' },
	check_project: { type: 'check_project', project: 'store-api', pull: true, no_smoke: true },
	add_workspace: {
		type: 'add_workspace',
		name: 'store-front',
		projects: ['store-front', 'store-api'],
		direct: false,
	},
	rm_workspace_project: {
		type: 'rm_workspace_project',
		workspace: 'store-front',
		project: 'signals',
		confirm: true,
	},
	rm_workspace: { type: 'rm_workspace', workspace: 'admin', confirm: true },
	add_worktree: { type: 'add_worktree', ref: 'store-front/wrk2', pull: true },
	rm_worktree: { type: 'rm_worktree', ref: 'store-front/wrk1', confirm: true },
	rename_worktree: { type: 'rename_worktree', ref: 'store-front/wrk1', name: 'checkout' },
	duplicate_worktree: { type: 'duplicate_worktree', ref: 'store-front/main', name: 'wrk3' },
	add_override: { type: 'add_override', ref: 'store-front/main', var: 'API_URL', value: 'x' },
	rm_override: { type: 'rm_override', ref: 'store-front/main', var: 'API_URL' },
	setup_rerun: {
		type: 'setup_rerun',
		ref: 'store-front/wrk1',
		projects: ['store-api'],
		no_smoke: true,
	},
	verify: { type: 'verify', ref: 'store-front/main', projects: ['store-front'] },
	dev_start: { type: 'dev_start', ref: 'store-front/main', proxy: true },
	dev_stop: { type: 'dev_stop', ref: 'store-front/main' },
	dev_restart: { type: 'dev_restart', ref: 'store-front/main' },
	claude_desktop: { type: 'claude_desktop', ref: 'store-front/main' },
	import_project: {
		type: 'import_project',
		bundle: BUNDLE,
		name: 'store-api',
		path: '/Users/dev/code/store-api',
		replace: true,
		rename: 'store-api-2',
		setup: 'pnpm install',
		env_cmd: 'make env',
		confirm: true,
	},
	import_workspace: {
		type: 'import_workspace',
		bundle: BUNDLE,
		name: 'store-front',
		pull: true,
		no_install: true,
		no_smoke: true,
	},
	import_all: { type: 'import_all', bundle: BUNDLE, replace: true, confirm: true },
	clean: { type: 'clean', confirm: true },
	trash_empty: { type: 'trash_empty', confirm: true },
	config_set: { type: 'config_set', key: 'server_ip', value: '192.168.1.20' },
	config_refresh: { type: 'config_refresh' },
	proxy_trust: { type: 'proxy_trust' },
	migrate: { type: 'migrate', confirm: true },
	update: { type: 'update' },
	server_restart: { type: 'server_restart' },
	server_stop: { type: 'server_stop', confirm: true },
	uninstall: { type: 'uninstall', mode: 'purge', confirm: true },
	machines_add: { type: 'machines_add', host: 'build-box', name: 'Build box' },
	machines_rm: { type: 'machines_rm', id: 'vm1', confirm: true },
	machines_rename: { type: 'machines_rename', id: 'vm1', name: 'Build box' },
	keys_set: { type: 'keys_set', name: 'soniox', value: 'sk-test' },
	discord_off: { type: 'discord_off' },
	ls_chats: { type: 'ls_chats' },
	chat_add: { type: 'chat_add', dir: '~/notes', name: 'Weekly notes' },
	chat_rm: { type: 'chat_rm', id: 'chat/3fa9c1' },
	discord_channels: { type: 'discord_channels' },
	discord_text_channel: { type: 'discord_text_channel', channel: '1001' },
};

// The other shape of a variant whose flags are optional: crew's help tree must know it too.
const SECOND_SAMPLES: SetupCommand[] = [
	{ type: 'chat_add' },
	{ type: 'uninstall', mode: 'keep', confirm: true },
	{ type: 'dev_add', project: 'store-api', name: 'worker' },
	{ type: 'add_worktree', ref: 'store-front/wrk2' },
	{ type: 'env', ref: 'store-front/main', project: 'store-front' },
	{ type: 'dev_add', project: 'store-api', name: 'http', rename: 'api', port: 0 },
];

const FIXTURE = join(import.meta.dir, '..', '..', 'test', 'fixtures', 'shared', 'setup-argv.json');
const TESTDATA = join(import.meta.dir, '..', '..', 'testdata');

const rows = [...Object.values(SAMPLES), ...SECOND_SAMPLES].map((command) => ({
	type: command.type,
	argv: toCrewArgv(command),
}));

describe('toCrewArgv', () => {
	it('every variant has a sample and the schema accepts it', () => {
		const types = SetupCommandSchema.options.map((option) => option.shape.type.value);

		expect(Object.keys(SAMPLES).sort()).toEqual([...types].sort());
		expect(Object.keys(COMMAND_TRAITS).sort()).toEqual([...types].sort());

		for (const sample of [...Object.values(SAMPLES), ...SECOND_SAMPLES]) {
			expect(parseSetupCommand(sample)).toEqual({ ok: true, command: sample });
		}
	});

	it('samples → the shared argv fixture crew walks through its help tree', () => {
		if (process.env.UPDATE_FIXTURES) {
			writeFileSync(FIXTURE, `${JSON.stringify(rows, null, '\t')}\n`);
		}

		expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(rows);
	});

	it.each([
		[{ type: 'ls_projects' }, ['ls', 'projects', '--json']],
		[{ type: 'ls_worktrees' }, ['ls', 'worktrees', '--json']],
		[{ type: 'dev_stop' }, ['dev', 'stop']],
		[
			{ type: 'add_project', url: 'https://github.com/acme/store-api' },
			['add', 'project', 'https://github.com/acme/store-api'],
		],
		[
			{ type: 'add_project', name: 'store-api', path: '~/code/store-api' },
			['add', 'project', 'store-api', '--path=~/code/store-api'],
		],
		[{ type: 'export', all: true }, ['export', '--all', '-']],
		[{ type: 'debug_tail' }, ['debug', '--tail=100']],
		[{ type: 'uninstall', mode: 'keep', confirm: true }, ['uninstall', '--yes']],
		[
			{ type: 'add_override', ref: 'a/b', var: 'K', value: 'x=y' },
			['add', 'override', 'a/b', 'K=x=y'],
		],
		[{ type: 'update_project', name: 'p', setup: '' }, ['add', 'project', 'p', '--setup=']],
		[{ type: 'config_set', key: 'domain', value: '' }, ['config', 'set', 'domain', '']],
	] as [SetupCommand, string[]][])('%j → %j', (command, argv) => {
		expect(toCrewArgv(command)).toEqual(argv);
	});
});

describe('--json only where crew prints a document', () => {
	const types = Object.keys(COMMAND_TRAITS) as SetupCommandType[];

	it('every variant that appends --json has a golden or a live run; none without', () => {
		expect(
			types.filter((type) => COMMAND_TRAITS[type].json !== (JSON_EVIDENCE[type] !== null)),
		).toEqual([]);
	});

	it.each(
		types.flatMap((type) => {
			const evidence = JSON_EVIDENCE[type];

			return evidence && evidence !== 'live' ? [[type, evidence.golden]] : [];
		}),
	)('%s → its golden %s parses', (_, golden) => {
		const file = join(TESTDATA, golden);

		expect(existsSync(file)).toBe(true);
		expect(() => JSON.parse(readFileSync(file, 'utf8')) as unknown).not.toThrow();
	});
});

describe('toCrewStdin', () => {
	it('bundles and keys go on stdin, never in argv', () => {
		expect(toCrewStdin(SAMPLES.keys_set)).toBe('sk-test');
		expect(toCrewArgv(SAMPLES.keys_set).join(' ')).not.toContain('sk-test');
		expect(toCrewStdin(SAMPLES.import_all)).toBe(BUNDLE);
		expect(toCrewArgv(SAMPLES.import_all).join(' ')).not.toContain('version');
		expect(toCrewStdin(SAMPLES.ls_projects)).toBeUndefined();
	});
});

describe('parseSetupCommand', () => {
	const refused = (input: unknown) => {
		const parsed = parseSetupCommand(input);

		return parsed.ok ? null : parsed.error;
	};

	it.each([
		['unknown type', { type: 'rm_everything' }],
		['extra field', { type: 'ls_projects', args: ['--purge'] }],
		['flag as a positional', { type: 'show', ref: '--help' }],
		['second line', { type: 'show', ref: 'a/b\nrm' }],
		['removal without confirm', { type: 'rm_worktree', ref: 'store-front/wrk1' }],
		['confirm false', { type: 'clean', confirm: false }],
		['replace without confirm', { type: 'import_all', bundle: BUNDLE, replace: true }],
		['url and path', { type: 'add_project', name: 'p', url: 'https://x/p', path: '/p' }],
		['neither name nor url', { type: 'add_project', path: '/p' }],
		['not an object', 'ls projects'],
		['flag value with a newline', { type: 'config_set', key: 'domain', value: 'a\nb' }],
		['config value that is a flag', { type: 'config_set', key: 'domain', value: '--help' }],
	])('%s → refused', (_, input) => {
		expect(refused(input)).not.toBeNull();
	});

	it('names the fields, never the values', () => {
		const error = refused({ type: 'keys_set', name: 'anthropic', value: '', extra: 'sk-secret' });

		expect(error).not.toContain('sk-secret');
		expect(error).toContain('value');
	});

	it('local-only: whatever stops, replaces or re-keys the machine answering, or opens a window on it', () => {
		const localOnly = Object.entries(COMMAND_TRAITS)
			.filter(([, traits]) => traits.localOnly)
			.map(([type]) => type)
			.sort();

		expect(localOnly).toEqual(
			[
				'claude_desktop',
				'discord_channels',
				'discord_off',
				'discord_status',
				'discord_text_channel',
				'keys_set',
				'keys_status',
				'machines_add',
				'machines_ls',
				'machines_rename',
				'machines_rm',
				'server_restart',
				'server_stop',
				'uninstall',
				'update',
			].sort(),
		);
	});
});
