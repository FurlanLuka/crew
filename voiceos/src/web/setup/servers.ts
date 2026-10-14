// The worktree's servers card, pure: what the card is showing (running, verifying, a failed
// install…), what it offers, its lines, and which log a line opens.
import type { SetupCommand } from '../../crew/commands.js';
import { readStepState } from './progress.js';
import type { CrewIssue, CrewSetupStatus, CrewWorktree } from './types.js';
import type { ServerLine } from './worktree.js';

export type CardMode =
	| 'stopped'
	| 'running'
	| 'died'
	| 'installing'
	| 'verifying'
	| 'setup-failed'
	| 'verify-failed';

// Each runner names its smoke steps "smoke <server>"; every other step is the checkout or install.
const SMOKE_STEP = 'smoke ';

const isSmokeStep = (name: string): boolean => name.startsWith(SMOKE_STEP);

// A runner is installing until it reaches its smoke steps: crew runs verify and setup alike, so the
// steps it is on are the only difference.
const isInstalling = (status: CrewSetupStatus | null): boolean =>
	status === null ||
	status.projects.some((project) => {
		const current = project.steps.findLast((step) => readStepState(step) === 'wait');

		return (
			(project.state === 'starting' || project.state === 'running') &&
			(current === undefined || !isSmokeStep(current.name))
		);
	});

export interface ReadCardModeParams {
	row: Pick<CrewWorktree, 'installing' | 'dev_running' | 'issues'>;
	// crew setup status, read only while a runner is alive.
	status: CrewSetupStatus | null;
	lines: ServerLine[];
}

// A runner at work outranks a recorded failure (it is about to replace it), and a recorded failure
// outranks what runs.
export const readCardMode = ({ row, status, lines }: ReadCardModeParams): CardMode => {
	if (row.installing) {
		return isInstalling(status) ? 'installing' : 'verifying';
	}

	const issue = row.issues?.[0];

	if (issue) {
		if (issue.stage !== 'smoke') {
			return 'setup-failed';
		}

		return row.dev_running ? 'died' : 'verify-failed';
	}

	if (!row.dev_running) {
		return 'stopped';
	}

	return lines.some((line) => line.state === 'died') ? 'died' : 'running';
};

export type CardAction = 'start' | 'stop' | 'restart' | 'verify' | 'install-again';

export const CARD_ACTIONS: Record<CardMode, CardAction[]> = {
	stopped: ['start', 'verify'],
	running: ['stop', 'restart', 'verify'],
	died: ['stop', 'restart', 'verify'],
	installing: [],
	verifying: [],
	'setup-failed': ['install-again'],
	'verify-failed': ['start', 'verify'],
};

// What the list shows: servers, except while a project installs or failed to, when the list is the
// projects being made (no server exists yet).
export const isProjectList = (mode: CardMode): boolean =>
	mode === 'installing' || mode === 'setup-failed';

// A server's line while a runner tries it: its "smoke <server>" step says how that went.
export const withSmokeSteps = (lines: ServerLine[], status: CrewSetupStatus | null): ServerLine[] =>
	lines.map((line) => {
		const step = status?.projects
			.find((project) => project.project === line.project)
			?.steps.find((candidate) => candidate.name === `${SMOKE_STEP}${line.name}`);

		if (!step) {
			return line;
		}

		const state = readStepState(step);

		return {
			...line,
			state:
				state === 'ok' ? 'up' : state === 'ask' ? 'died' : state === 'wait' ? 'quiet' : line.state,
		};
	});

export interface LogTarget {
	project: string;
	// None: the project's install.
	server: string | null;
}

export interface LogCommandForParams {
	mode: CardMode;
	ref: string;
	target: LogTarget;
	lines: number;
}

// Which log a line opens: the install while it installs or failed to, what the runner's try
// printed while verifying or when that try failed, else the dev server's own log.
export const logCommandFor = ({ mode, ref, target, lines }: LogCommandForParams): SetupCommand => {
	if (target.server === null || isProjectList(mode)) {
		return { type: 'setup_logs', ref, project: target.project, lines };
	}

	if (mode === 'verifying' || mode === 'verify-failed') {
		return { type: 'setup_logs', ref, project: target.project, server: target.server, lines };
	}

	return { type: 'dev_logs', ref, server: target.server, lines };
};

// Opened by itself when nothing was picked: the server that died, or the project that failed.
export const pickStartTarget = (
	mode: CardMode,
	lines: ServerLine[],
	issue: CrewIssue | undefined,
): LogTarget | null => {
	if (mode === 'setup-failed' && issue) {
		return { project: issue.project, server: null };
	}

	if (mode === 'verify-failed' && issue?.server) {
		return { project: issue.project, server: issue.server };
	}

	const died = lines.find((line) => line.state === 'died');

	return died ? { project: died.project, server: died.name } : null;
};
