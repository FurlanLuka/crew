// The import page's logic, pure: what each item of crew's plan can become, the choice each starts
// with, which workspaces can be made from those choices, and the commands one Import runs.
import type { SetupCommand } from '../../crew/commands.js';
import { countOf } from '../count.js';
import type { PlanRow } from './readers.js';

export type ChoiceKind = 'keep' | 'clone' | 'mine' | 'folder' | 'rename' | 'replace' | 'skip';

export interface Choice {
	kind: ChoiceKind | null;
	// A folder to use, for 'folder'.
	path: string;
	// The name to import under, for 'rename'.
	rename: string;
}

// What a project row offers, first the one it starts with (null: nothing until you pick).
export const optionsFor = (row: PlanRow): { options: ChoiceKind[]; start: ChoiceKind | null } => {
	switch (row.status) {
		case 'exists':
			return { options: ['keep', 'replace'], start: 'keep' };
		case 'clone':
			return { options: ['clone'], start: 'clone' };
		case 'found':
			return { options: ['mine', 'clone'], start: 'mine' };
		case 'missing':
			return { options: ['folder', 'skip'], start: null };
		case 'other remote':
			return { options: ['rename', 'replace', 'skip'], start: null };
		case 'blocked':
			return { options: ['folder', 'rename', 'skip'], start: null };
		default:
			return { options: ['skip'], start: null };
	}
};

// Nothing picked yet; Import as offers the name with -2.
export const blankChoice = (name: string): Choice => ({
	kind: null,
	path: '',
	rename: `${name}-2`,
});

export const startChoices = (rows: PlanRow[]): Record<string, Choice> =>
	Object.fromEntries(
		rows
			.filter((row) => row.kind === 'project')
			.map((row) => [row.name, { ...blankChoice(row.name), kind: optionsFor(row).start }]),
	);

export const CHOICE_LABELS: Record<ChoiceKind, string> = {
	keep: 'Keep mine',
	clone: 'Clone',
	mine: 'Use mine',
	folder: 'Point at a folder',
	rename: 'Import as',
	replace: 'Replace mine',
	skip: 'Skip',
};

// Where a row goes on the page: a choice to make, something that will just happen, or nothing.
export const sectionOf = (row: PlanRow): 'needs' | 'will' | 'here' =>
	row.status === 'exists'
		? 'here'
		: row.status === 'clone' || row.status === 'found'
			? 'will'
			: 'needs';

const isComplete = (choice: Choice | undefined): boolean =>
	Boolean(
		choice?.kind &&
			(choice.kind !== 'folder' || choice.path.trim()) &&
			(choice.kind !== 'rename' || choice.rename.trim()),
	);

export const countOpen = (rows: PlanRow[], choices: Record<string, Choice>): number =>
	rows.filter((row) => row.kind === 'project' && !isComplete(choices[row.name])).length;

export interface WorkspaceState {
	name: string;
	members: string[];
	// Why it can't be made from these choices, or waits on one; null: it can.
	blockedBy: string | null;
	waitsOn: string[];
}

// crew makes a workspace from its members exactly as the export names them, so a member that is
// skipped, renamed, or left as a different repo here leaves it unmakeable.
export const readWorkspace = (
	row: PlanRow,
	members: string[],
	projects: PlanRow[],
	choices: Record<string, Choice>,
): WorkspaceState => {
	const waitsOn: string[] = [];
	const lost: string[] = [];

	for (const member of members) {
		const project = projects.find((each) => each.name === member);
		const choice = choices[member];

		if (!project) {
			continue;
		}

		if (!choice?.kind) {
			waitsOn.push(member);
		} else if (
			choice.kind === 'skip' ||
			choice.kind === 'rename' ||
			(project.status === 'other remote' && choice.kind !== 'replace')
		) {
			lost.push(member);
		}
	}

	const blockedBy =
		row.status === 'exists' ? 'already here' : lost.length ? `needs ${lost.join(', ')}` : null;

	return { name: row.name, members, blockedBy, waitsOn };
};

export const projectCommand = (
	row: PlanRow,
	choice: Choice,
	bundle: string,
): SetupCommand | null => {
	const base = { type: 'import_project' as const, bundle, name: row.name };

	switch (choice.kind) {
		case 'clone':
			return base;
		case 'mine':
			return { ...base, path: row.detail };
		case 'folder':
			return { ...base, path: choice.path.trim() };
		case 'rename':
			return { ...base, rename: choice.rename.trim() };
		case 'replace':
			return { ...base, replace: true, confirm: true };
		default:
			return null;
	}
};

export interface ImportRun {
	projects: { name: string; command: SetupCommand }[];
	workspaces: { name: string; command: SetupCommand }[];
}

// Everything one Import runs, in crew's order: projects first, then the workspaces made of them.
export const buildRun = (
	rows: PlanRow[],
	choices: Record<string, Choice>,
	ticked: string[],
	bundle: string,
): ImportRun => ({
	projects: rows.flatMap((row) => {
		const choice = choices[row.name];
		const command = row.kind === 'project' && choice ? projectCommand(row, choice, bundle) : null;

		return command ? [{ name: row.name, command }] : [];
	}),
	workspaces: rows
		.filter((row) => row.kind === 'workspace' && ticked.includes(row.name))
		.map((row) => ({
			name: row.name,
			command: { type: 'import_workspace' as const, bundle, name: row.name },
		})),
});

export const describeSummary = (
	rows: PlanRow[],
	choices: Record<string, Choice>,
	ticked: string[],
): { text: string; tone: 'ask' | 'ok' | '' }[] => {
	const open = countOpen(rows, choices);
	const projects = rows.filter((row) => row.kind === 'project');
	const clones = projects.filter((row) => choices[row.name]?.kind === 'clone').length;
	const mine = projects.filter((row) => choices[row.name]?.kind === 'mine').length;
	const here = projects.filter((row) => row.status === 'exists').length;

	return [
		open
			? { text: `${countOf(open, 'project')} need${open === 1 ? 's' : ''} a choice`, tone: 'ask' }
			: { text: 'every choice made', tone: 'ok' },
		...(clones ? [{ text: countOf(clones, 'clone'), tone: '' as const }] : []),
		...(mine ? [{ text: `${mine} already checked out`, tone: '' as const }] : []),
		{ text: countOf(ticked.length, 'workspace'), tone: '' },
		...(here ? [{ text: `${here} already here`, tone: '' as const }] : []),
	];
};
