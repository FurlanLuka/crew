// What the project form saves, pure: its server rows, the commands a save runs and where an
// Environment value can come from.
import type { SetupCommand } from '../../crew/commands.js';
import type { CrewDevServer, CrewProject } from './types.js';

export interface ServerRow {
	key: number;
	// The name crew has it under; null for a row added here.
	original: string | null;
	name: string;
	command: string;
	dir: string;
	port: string;
}

export const toRow = (server: CrewDevServer, key: number): ServerRow => ({
	key,
	original: server.name,
	name: server.name,
	command: server.command,
	dir: server.dir ?? '',
	port: server.port ? String(server.port) : '',
});

const isRowChanged = (row: ServerRow, servers: CrewDevServer[]): boolean => {
	const before = servers.find((server) => server.name === row.original);

	return (
		!before ||
		before.name !== row.name ||
		before.command !== row.command ||
		(before.dir ?? '') !== row.dir ||
		String(before.port ?? '') !== row.port
	);
};

export interface PlanProjectSaveParams {
	project: CrewProject;
	setup: string;
	envCmd: string;
	rows: ServerRow[];
	binding: { var: string; value: string; server: string } | null;
}

// The port a row sends: its number, 0 when the row cleared the port its server had (crew dev add
// --port=0, it no longer listens), or nothing to leave crew's as it is.
const toPort = (row: ServerRow, servers: CrewDevServer[]): { port?: number } => {
	const port = Number(row.port);

	if (row.port.trim() && Number.isInteger(port) && port > 0) {
		return { port };
	}

	const before = servers.find((server) => server.name === row.original);

	return !row.port.trim() && before?.port ? { port: 0 } : {};
};

// A rename keeps the old dir unless one is given, so a dir the row cleared is sent as empty.
const toDir = (row: ServerRow, servers: CrewDevServer[]): { dir?: string } => {
	if (row.dir.trim()) {
		return { dir: row.dir.trim() };
	}

	const before = servers.find((server) => server.name === row.original);

	return before?.dir ? { dir: '' } : {};
};

// The commands a save runs, in order: install, servers (renames in place), removals, environment.
export const planProjectSave = ({
	project,
	setup,
	envCmd,
	rows,
	binding,
}: PlanProjectSaveParams): SetupCommand[] => {
	const commands: SetupCommand[] = [];
	const servers = project.dev_servers ?? [];

	if (setup !== (project.setup ?? '') || envCmd !== (project.env_cmd ?? '')) {
		commands.push({
			type: 'update_project',
			name: project.name,
			...(setup !== (project.setup ?? '') ? { setup } : {}),
			...(envCmd !== (project.env_cmd ?? '') ? { env_cmd: envCmd } : {}),
		});
	}

	for (const row of rows) {
		if (!row.name.trim() || !row.command.trim() || !isRowChanged(row, servers)) {
			continue;
		}

		commands.push({
			type: 'dev_add',
			project: project.name,
			name: row.name.trim(),
			cmd: row.command.trim(),
			...(row.original && row.original !== row.name.trim() ? { rename: row.original } : {}),
			...toDir(row, servers),
			...toPort(row, servers),
		});
	}

	for (const server of servers) {
		if (!rows.some((row) => row.original === server.name)) {
			commands.push({ type: 'dev_rm', project: project.name, server: server.name });
		}
	}

	if (binding?.var.trim() && binding.value) {
		commands.push({
			type: 'add_binding',
			project: project.name,
			var: binding.var.trim(),
			value: binding.value,
			...(binding.server ? { server: binding.server } : {}),
		});
	}

	return commands;
};

export interface SourceOption {
	value: string;
	label: string;
}

// Where a value can come from: another project's URL or port in the same worktree, the
// worktree's or workspace's name, or a fixed value.
export const listSources = (projects: CrewProject[], self: string): SourceOption[] => [
	...projects
		.filter((project) => project.name !== self && project.dev_servers?.length)
		.flatMap((project) => {
			const servers = (project.dev_servers ?? []).filter((server) => server.port);
			const isSingle = servers.length === 1;

			return servers.flatMap((server) => {
				const target = isSingle ? project.name : `${project.name}/${server.name}`;
				const who = isSingle ? project.name : `${project.name} ${server.name}`;

				return [
					{ value: `{{${target}}}`, label: `${who}'s URL` },
					{ value: `{{${target}.port}}`, label: `${who}'s port` },
				];
			});
		}),
	{ value: '{{worktree}}', label: "the worktree's name" },
	{ value: '{{workspace}}', label: "the workspace's name" },
	{ value: 'fixed', label: 'a fixed value' },
];
