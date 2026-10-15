// What the workspace page and form read and run, pure: its worktrees as cards, the wires between
// ticked projects and the commands that make a workspace or add to it.
import type { SetupCommand } from '../../crew/commands.js';
import { type WorktreeState, describeIssue, readWorktreeState } from './derive.js';
import type { CrewProject, CrewWorktree } from './types.js';

// Which bindings of the ticked projects reach another project, and whether that one is ticked too.
export const listWires = (
	projects: CrewProject[],
	ticked: string[],
): { from: string; variable: string; to: string; isTicked: boolean }[] =>
	projects
		.filter((project) => ticked.includes(project.name))
		.flatMap((project) =>
			(project.bindings ?? []).flatMap((binding) =>
				[...binding.value.matchAll(/\{\{\s*(?:url:|port:)?([^}./\s]+)/g)]
					.map((match) => match[1] ?? '')
					.filter(
						(target) =>
							target && target !== 'worktree' && target !== 'workspace' && target !== project.name,
					)
					.map((target) => ({
						from: project.name,
						variable: binding.var,
						to: target,
						isTicked: ticked.includes(target),
					})),
			),
		);

export type Mode = 'worktree' | 'direct';

export const planWorkspace = (
	name: string,
	picks: Record<string, Mode>,
	members: string[],
): SetupCommand[] => {
	const added = Object.entries(picks).filter(([project]) => !members.includes(project));
	const worktree = added.filter(([, mode]) => mode === 'worktree').map(([project]) => project);
	const direct = added.filter(([, mode]) => mode === 'direct').map(([project]) => project);
	const commands: SetupCommand[] = [];

	if (!name.trim()) {
		return commands;
	}

	if (worktree.length > 0 || (direct.length === 0 && members.length === 0)) {
		commands.push({ type: 'add_workspace', name: name.trim(), projects: worktree });
	}

	if (direct.length > 0) {
		commands.push({ type: 'add_workspace', name: name.trim(), projects: direct, direct: true });
	}

	return commands;
};

export type PillState = 'up' | 'died' | 'wait' | 'stopped';

export interface ServerPill {
	project: string;
	name: string;
	state: PillState;
}

export interface WorktreeCard {
	ref: string;
	name: string;
	state: WorktreeState;
	status: string;
	sizeBytes: number | undefined;
	servers: ServerPill[];
}

export interface ListWorktreeCardsParams {
	workspace: string;
	// crew ls worktrees, read fast and often.
	rows: CrewWorktree[];
	// The same read with --size: a walk of every checkout, read once and late.
	sizes: CrewWorktree[];
	members: string[];
	projects: CrewProject[];
}

const STATUS: Record<Exclude<WorktreeState, 'issue'>, string> = {
	installing: 'installing…',
	running: 'servers running',
	stopped: 'stopped',
};

// Only what a worktree row says: running or not, and which server a recorded failure names. Ports
// and per-server liveness are the worktree page's (crew dev check).
const readPill = (row: CrewWorktree, project: string, server: string): PillState => {
	const isDead = (row.issues ?? []).some(
		(issue) => issue.stage === 'smoke' && issue.project === project && issue.server === server,
	);

	return isDead ? 'died' : row.installing ? 'wait' : row.dev_running ? 'up' : 'stopped';
};

export const listWorktreeCards = ({
	workspace,
	rows,
	sizes,
	members,
	projects,
}: ListWorktreeCardsParams): WorktreeCard[] =>
	rows
		.filter((row) => row.ref.startsWith(`${workspace}/`))
		.map((row) => {
			const state = readWorktreeState(row);
			const issue = row.issues?.[0];

			return {
				ref: row.ref,
				name: row.ref.slice(workspace.length + 1),
				state,
				status:
					state === 'issue' && issue
						? describeIssue(issue)
						: STATUS[state === 'issue' ? 'stopped' : state],
				sizeBytes: sizes.find((sized) => sized.ref === row.ref)?.size_bytes,
				servers: members.flatMap((member) =>
					(projects.find((project) => project.name === member)?.dev_servers ?? []).map(
						(server) => ({
							project: member,
							name: server.name,
							state: readPill(row, member, server.name),
						}),
					),
				),
			};
		});
