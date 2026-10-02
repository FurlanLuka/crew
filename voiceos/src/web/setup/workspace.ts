// What the workspace page and form read and run, pure: the wires between ticked projects and the
// commands that make a workspace or add to it.
import type { SetupCommand } from '../../crew/commands.js';
import type { CrewProject } from './types.js';

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
