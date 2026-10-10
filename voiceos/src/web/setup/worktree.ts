// What the worktree page reads, derived: its servers' lines, the values set for this worktree (crew's
// overrides) and what each replaces, the command the form makes, and why a recorded failure
// matters. Pure, beside its spec.
import type { SetupCommand } from '../../crew/commands.js';
import { countOf } from '../count.js';
import { describeBindingSource } from './environment.js';
import type {
	CrewBinding,
	CrewIssue,
	CrewMember,
	CrewProject,
	CrewRoute,
	CrewSmoke,
} from './types.js';

export interface ServerLine {
	project: string;
	name: string;
	command: string;
	port: number | null;
	url: string | null;
	state: 'up' | 'died' | 'quiet' | 'stopped';
}

export interface ListServerLinesParams {
	members: CrewMember[];
	projects: CrewProject[];
	checks: CrewSmoke[];
	routes: CrewRoute[];
	worktreeRef: string;
}

// Every server the worktree's projects declare, with what crew sees of it now. Server names are
// unique only within a project, so a route that names its project must name this one.
export const listServerLines = ({
	members,
	projects,
	checks,
	routes,
	worktreeRef,
}: ListServerLinesParams): ServerLine[] =>
	members.flatMap((member) =>
		(projects.find((project) => project.name === member.name)?.dev_servers ?? []).map((server) => {
			const check = checks.find((row) => row.project === member.name && row.server === server.name);
			const route = routes.find(
				(row) =>
					row.worktree === worktreeRef &&
					row.server_name === server.name &&
					(!row.project || row.project === member.name),
			);
			const state: ServerLine['state'] = !check
				? 'stopped'
				: !check.alive
					? 'died'
					: check.listening || !check.port
						? 'up'
						: 'quiet';

			return {
				project: member.name,
				name: server.name,
				command: server.command,
				port: check?.port || route?.external_port || null,
				url: route?.url || null,
				state,
			};
		}),
	);

// crew ls overrides --json: VAR (every project) or project.VAR, to its value.
export const readOverrides = (json: unknown): { key: string; value: string }[] =>
	json && typeof json === 'object' && !Array.isArray(json)
		? Object.entries(json as Record<string, unknown>).map(([key, value]) => ({
				key,
				value: String(value),
			}))
		: [];

export interface OverrideLine {
	key: string;
	// The variable, without its project prefix.
	name: string;
	// "every project" or "store-api only".
	scope: string;
	// What it wins over: "instead of store-front's value: store-api api's URL", when a project binds the same var.
	instead: string | null;
}

// One project's bindings of a var: "value: <the project page's words>" for one ("value: store-api
// api's URL", a scoped one naming its server as the CLI labels it, "(web)"), "N values" for more.
// The owner comes first so two possessives never sit side by side.
const describeReplaced = (bindings: CrewBinding[]): string => {
	const [binding] = bindings;

	if (bindings.length > 1 || !binding) {
		return countOf(bindings.length, 'value');
	}

	const source = describeBindingSource(binding.value);

	return `value: ${binding.server ? `${source} (${binding.server})` : source}`;
};

// One value set for this worktree, in the project page's words: the variable, which projects get it,
// and the project's own value it replaces.
export const describeOverride = (
	key: string,
	members: CrewMember[],
	projects: CrewProject[],
): OverrideLine => {
	const dot = key.indexOf('.');
	const project = dot > 0 ? key.slice(0, dot) : '';
	const name = dot > 0 ? key.slice(dot + 1) : key;
	const names = project ? [project] : members.map((member) => member.name);
	// A worktree value beats the project's scoped bindings as well as its project-wide one, so each
	// project counts once whichever of them it has.
	const replaced = projects.flatMap((candidate) => {
		const bindings = names.includes(candidate.name)
			? (candidate.bindings ?? []).filter((row) => row.var === name)
			: [];

		return bindings.length ? [{ project: candidate.name, bindings }] : [];
	});
	const [only] = replaced;

	return {
		key,
		name,
		scope: project ? `${project} only` : 'every project',
		instead:
			replaced.length > 1
				? `instead of the values of ${countOf(replaced.length, 'project')}`
				: only
					? `instead of ${project ? 'the project' : only.project}'s ${describeReplaced(only.bindings)}`
					: null,
	};
};

export interface ToOverrideCommandParams {
	ref: string;
	// What the field holds: VAR=value (the value may hold '=' itself).
	text: string;
	// '' for every project.
	project: string;
}

// The form's crew add override, or null while it names no variable.
export const toOverrideCommand = ({
	ref,
	text,
	project,
}: ToOverrideCommandParams): SetupCommand | null => {
	const [variable = '', ...rest] = text.split('=');
	const name = variable.trim();

	return name
		? {
				type: 'add_override',
				ref,
				var: project ? `${project}.${name}` : name,
				value: rest.join('='),
			}
		: null;
};

// What a recorded failure means for the worktree's session.
export const describeIssueWhy = (issue: CrewIssue): string =>
	issue.stage === 'install'
		? `${issue.project}'s install failed here, so its session can read and change the code but not run it.`
		: issue.stage === 'checkout'
			? `git could not check ${issue.project} out here.`
			: `${issue.server ?? issue.project} ${issue.reason === 'not listening' ? 'runs but never answered on its port' : 'stopped'}.`;

export interface DesktopLinkParams {
	// What Desktop runs ssh to: crew's ssh_host for this Mac, the machine's SSH host for another.
	sshHost: string;
	folder: string;
}

// Claude Desktop's own link for a session over SSH, opened on the computer the developer sits at.
// null without a host: there is nothing for Desktop to connect to.
export const desktopLink = ({ sshHost, folder }: DesktopLinkParams): string | null =>
	sshHost
		? `claude://code/new?ssh_host=${encodeURIComponent(sshHost)}&ssh_folder=${encodeURIComponent(folder)}`
		: null;

// The one folder Desktop opens, as crew claude --desktop picks it: Desktop takes no --add-dir, so a
// worktree of several projects opens at its root.
export const desktopFolder = (members: CrewMember[], worktreePath: string): string => {
	const [only] = members;

	return members.length === 1 && only ? only.path : worktreePath;
};
