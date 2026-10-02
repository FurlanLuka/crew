// The first run's logic, pure: which step crew's state allows, a runner's row as the flow draws it,
// how far the worktree has come, and what the last step says.
import { countOf } from '../count.js';
import { type LineState, isRunning, listFailedProjects, readStepState } from '../setup/progress.js';
import type { CrewProject, CrewSetupStatus } from '../setup/types.js';

export type FirstRunStep = 'intro' | 'projects' | 'workspace' | 'prepare' | 'ready';

// The steps the line under the wordmark names, in order; the opening and the last step have none.
export const PROGRESS_STEPS: { step: FirstRunStep; title: string }[] = [
	{ step: 'projects', title: 'Projects' },
	{ step: 'workspace', title: 'Workspace' },
	{ step: 'prepare', title: 'Getting it ready' },
];

// The step after the opening: past whatever crew already has.
export const firstStepFor = (pool: CrewProject[]): FirstRunStep =>
	pool.length > 0 ? 'workspace' : 'projects';

export type RunnerState = 'waiting' | 'running' | 'ok' | 'failed';

export interface RunnerStep {
	name: string;
	state: LineState;
}

export interface RunnerRow {
	project: string;
	state: RunnerState;
	steps: RunnerStep[];
	// Right of the row: the step running now, or how it ended.
	side: string;
}

const readRunnerState = (projectState: string, steps: RunnerStep[]): RunnerState => {
	switch (projectState) {
		case 'ok':
			return 'ok';
		case 'failed':
		case 'interrupted':
			return 'failed';
		default:
			return steps.length === 0 ? 'waiting' : 'running';
	}
};

const SIDE: Record<RunnerState, string> = {
	waiting: 'waiting',
	running: '',
	ok: 'ready',
	failed: 'failed',
};

// One row per project being made, with crew's own step names.
export const listRunnerRows = (status: CrewSetupStatus | null): RunnerRow[] =>
	(status?.projects ?? []).map((project) => {
		const steps = project.steps.map((step) => ({ name: step.name, state: readStepState(step) }));
		const state = readRunnerState(project.state, steps);

		return {
			project: project.project,
			state,
			steps,
			side: SIDE[state] || (steps.findLast((step) => step.state === 'wait')?.name ?? 'working'),
		};
	});

// How far the worktree has come, 0–1: a finished project counts whole, a running one by its
// finished steps out of the ones crew has listed so far plus the one to come.
export const progressOf = (status: CrewSetupStatus | null): number => {
	const rows = listRunnerRows(status);

	if (rows.length === 0) {
		return 0;
	}

	const share = rows.map((row) =>
		row.state === 'ok' || row.state === 'failed'
			? 1
			: row.steps.filter((step) => step.state === 'ok').length / (row.steps.length + 1),
	);

	return share.reduce((sum, part) => sum + part, 0) / rows.length;
};

// Moves on by itself only when every runner finished clean; a status not read yet never does.
export const isCleanFinish = (status: CrewSetupStatus | null): boolean =>
	status !== null &&
	status.projects.length > 0 &&
	!isRunning(status) &&
	listFailedProjects(status).length === 0;

export interface ReadyCopy {
	lead: string;
	// Nothing installed: Set up is where to go next, not a session that cannot run anything.
	isNothingInstalled: boolean;
}

export const describeReady = (status: CrewSetupStatus | null): ReadyCopy => {
	const total = status?.projects.length ?? 0;
	const failed = listFailedProjects(status).map((project) => project.project);
	const installed = total - failed.length;

	if (failed.length === 0) {
		return {
			lead: `${countOf(total, 'project')} checked out and installed.`,
			isNothingInstalled: false,
		};
	}

	const which = `${failed.join(', ')} failed: Set up shows ${failed.length === 1 ? 'it' : 'them'}.`;

	return installed === 0
		? { lead: `Nothing installed; ${which}`, isNothingInstalled: true }
		: {
				lead: `${installed} of ${countOf(total, 'project')} installed; ${which}`,
				isNothingInstalled: false,
			};
};
