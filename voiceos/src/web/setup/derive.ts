// Set up's view logic, pure: the board's rows and problems, what "not set up" means, the first-run
// stage and a failure's stages. The breadcrumbs are in crumbs.ts, the chat's "✓ recorded" lines in
// recorded.ts.
import { countOf } from '../count.js';
import type { SetupPage } from '../router.js';
import type {
	CrewCheckStatus,
	CrewIssue,
	CrewProject,
	CrewWorkspace,
	CrewWorktree,
} from './types.js';

// crew check project <p> keeps its target as check/<p>: a worktree only crew makes.
const CHECK_PREFIX = 'check/';

export const isCheckRef = (ref: string): boolean => ref.startsWith(CHECK_PREFIX);

export const checkProjectOf = (ref: string): string => ref.slice(CHECK_PREFIX.length);

export type FirstRunStage = 'empty' | 'has-projects' | 'ready';

// Nothing persisted: the stage is what crew has. Voice OS needs a worktree to talk to.
export const deriveFirstRun = (
	projects: CrewProject[] | null,
	worktrees: CrewWorktree[] | null,
): FirstRunStage => {
	if (projects === null || worktrees === null) {
		return 'ready';
	}

	if (projects.length === 0) {
		return 'empty';
	}

	return worktrees.some((worktree) => !isCheckRef(worktree.ref)) ? 'ready' : 'has-projects';
};

// "Not set up" is a project with no dev servers: its sessions work on the code meanwhile.
export const isNotSetUp = (project: CrewProject): boolean => !project.dev_servers?.length;

export type ProjectState = 'ready' | 'failed' | 'setup';

export const readCheckFailure = (project: string, worktrees: CrewWorktree[]): CrewIssue | null =>
	worktrees.find((worktree) => worktree.ref === `${CHECK_PREFIX}${project}`)?.issues?.[0] ?? null;

export interface CheckView {
	state: 'passed' | 'running' | 'failed' | 'none';
	// The first thing the check found wrong: from its status, else from the kept check/<p> target.
	failure: CrewIssue | null;
	// When it last decided, for "passed 3 h ago".
	at: string | null;
}

// crew check project <p> --status --json for the board and the project page. A failure kept as the
// check/<p> worktree counts even before the status says so.
export const readCheck = (
	status: CrewCheckStatus | null,
	project: string,
	worktrees: CrewWorktree[],
): CheckView => {
	const failure = status?.health?.issues[0] ?? readCheckFailure(project, worktrees);
	const state =
		status?.state === 'passed' || status?.state === 'running'
			? status.state
			: status?.state === 'failed' || failure
				? 'failed'
				: 'none';

	return { state, failure, at: status?.at ?? null };
};

// "Check again" only once there was a check: a project never checked is checked, not re-checked.
export const describeCheckAction = (state: CheckView['state']): string =>
	state === 'none' ? 'Check' : 'Check again';

// The workspaces a project is a member of.
export const listWorkspacesOf = (workspaces: CrewWorkspace[], project: string): CrewWorkspace[] =>
	workspaces.filter((workspace) => workspace.projects?.some((member) => member.name === project));

export const deriveProjectState = (
	project: CrewProject,
	worktrees: CrewWorktree[],
): ProjectState => {
	if (readCheckFailure(project.name, worktrees)) {
		return 'failed';
	}

	return isNotSetUp(project) ? 'setup' : 'ready';
};

// The last line of what crew kept: the error, where the first is often the command that printed it.
const readLastLine = (detail: string): string =>
	detail
		.split('\n')
		.findLast((line) => line.trim())
		?.trim() ?? '';

// One line for an issue crew recorded: "web died · Cannot find module 'next'".
// isNamed: false where the project is already said ("store-api: install failed"), so it is not
// said twice.
export const describeIssue = (issue: CrewIssue, { isNamed = true } = {}): string => {
	const lastLine = readLastLine(issue.detail);
	const what =
		issue.stage === 'smoke'
			? `${issue.server ?? issue.project} ${issue.reason === 'not listening' ? 'is not listening' : 'died'}`
			: isNamed
				? `${issue.project} ${issue.stage} failed`
				: `${issue.stage} failed`;

	return lastLine ? `${what} · ${lastLine}` : what;
};

export interface Problem {
	key: string;
	// Red needs you; a ring is "not finished", quieter.
	isQuiet: boolean;
	name: string;
	what: string;
	// The page that has its fix; null when the fix is Claude's alone.
	fix: SetupPage | null;
	// What "Fix with Claude" / "Set up with Claude" sends to the machine's setup chat.
	ask: string;
}

// The strip above the board: failed checks and broken worktrees first, then one quiet row for
// the projects not set up yet.
export const listProblems = (projects: CrewProject[], worktrees: CrewWorktree[]): Problem[] => {
	const failing = worktrees.flatMap((worktree): Problem[] => {
		const issue = worktree.issues?.[0];

		if (!issue) {
			return [];
		}

		if (isCheckRef(worktree.ref)) {
			const project = checkProjectOf(worktree.ref);

			return [
				{
					key: worktree.ref,
					isQuiet: false,
					name: project,
					what: `check failed at ${issue.stage} · ${readLastLine(issue.detail)}`,
					fix: { page: 'project', name: project },
					ask: `Fix ${project}: its check failed at ${issue.stage} (${describeIssue(issue)}).`,
				},
			];
		}

		return [
			{
				key: worktree.ref,
				isQuiet: false,
				name: worktree.ref,
				what: describeIssue(issue),
				fix: { page: 'worktree', ref: worktree.ref },
				ask: `In ${worktree.ref}: ${describeIssue(issue)}. Fix it.`,
			},
		];
	});
	const notSetUp = projects.filter(isNotSetUp).map((project) => project.name);

	if (notSetUp.length === 0) {
		return failing;
	}

	const quiet: Problem =
		notSetUp.length === 1
			? {
					key: 'not-set-up',
					isQuiet: true,
					name: notSetUp[0] ?? '',
					what: 'not set up yet · its sessions work on the code meanwhile',
					fix: { page: 'project-edit', name: notSetUp[0] ?? '' },
					ask: `Set up ${notSetUp[0]}: work out its dev servers, record them, and run the check.`,
				}
			: {
					key: 'not-set-up',
					isQuiet: true,
					name: `${countOf(notSetUp.length, 'project')} not set up`,
					what: 'no dev servers yet · set each up below, or let Claude work them out',
					fix: null,
					ask: `Set up ${notSetUp.join(', ')}: work out each one's dev servers, record them, and run the check.`,
				};

	return [...failing, quiet];
};

// How many things need the developer on a machine (the machine menu and Home say this).
export const countNeedsYou = (projects: CrewProject[], worktrees: CrewWorktree[]): number =>
	listProblems(projects, worktrees).filter((problem) => !problem.isQuiet).length;

// A recorded failure's place in a worktree's making: the stages before it passed, the rest never ran.
const STAGES = ['checkout', 'install', 'smoke'];
const STAGE_LABELS: Record<string, string> = {
	checkout: 'checkout',
	install: 'install',
	smoke: 'servers',
};

export const describeStages = (failedAt: string) => {
	const index = STAGES.indexOf(failedAt);

	return STAGES.map((stage, at) => ({
		name: STAGE_LABELS[stage] ?? stage,
		status: at < index ? ('ok' as const) : at === index ? ('bad' as const) : ('skip' as const),
	}));
};
