// The export page's logic, pure: which projects a pick of workspaces brings along, and the one
// crew export it runs.
import type { SetupCommand } from '../../crew/commands.js';
import type { CrewWorkspace } from './types.js';

export const membersOf = (workspace: CrewWorkspace): string[] =>
	(workspace.projects ?? []).map((project) => project.name);

// Projects in no workspace here: picked on their own.
export const listLoose = (projects: string[], workspaces: CrewWorkspace[]): string[] =>
	projects.filter((name) => !workspaces.some((workspace) => membersOf(workspace).includes(name)));

// A workspace's projects come with it: crew refuses a workspace whose projects are not exported.
export const listExported = (
	workspaces: CrewWorkspace[],
	pickedWorkspaces: string[],
	pickedLoose: string[],
): string[] => [
	...new Set([
		...workspaces
			.filter((workspace) => pickedWorkspaces.includes(workspace.name))
			.flatMap(membersOf),
		...pickedLoose,
	]),
];

interface ExportCommandParams {
	workspaces: CrewWorkspace[];
	loose: string[];
	pickedWorkspaces: string[];
	pickedLoose: string[];
}

// Everything picked is crew's default (--all); nothing picked runs nothing.
export const exportCommand = ({
	workspaces,
	loose,
	pickedWorkspaces,
	pickedLoose,
}: ExportCommandParams): SetupCommand | null => {
	const projects = listExported(workspaces, pickedWorkspaces, pickedLoose);

	if (projects.length === 0) {
		return null;
	}

	if (pickedWorkspaces.length === workspaces.length && pickedLoose.length === loose.length) {
		return { type: 'export', all: true };
	}

	return {
		type: 'export',
		projects,
		...(pickedWorkspaces.length ? { workspaces: pickedWorkspaces } : {}),
	};
};
