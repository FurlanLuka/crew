// What the worktree page reads, derived: its servers' lines, its pinned values, the pin a form makes
// and why a recorded failure matters. Pure, beside its spec.
import type { SetupCommand } from '../../crew/commands.js';
import type { CrewIssue, CrewMember, CrewProject, CrewRoute, CrewSmoke } from './types.js';

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

export interface ToPinCommandParams {
	ref: string;
	// What the field holds: VAR=value (the value may hold '=' itself).
	pin: string;
	// '' for every project.
	project: string;
}

// The pin form's command, or null while it names no variable.
export const toPinCommand = ({ ref, pin, project }: ToPinCommandParams): SetupCommand | null => {
	const [variable = '', ...rest] = pin.split('=');
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
