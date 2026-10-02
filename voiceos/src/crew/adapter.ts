import { CHAT_WORKSPACE, isChatRef } from '../shared/machine-ref.js';
import type { WorktreeInfo } from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { parseCheckRows, parseRouteRows, type CheckRow, type RouteRow } from '../dev/servers.js';

const log = createLogger('crew');

export interface CrewRunOptions {
	cwd?: string;
	// Past it crew is killed and the result says timedOut.
	timeoutMs?: number;
	// A bundle to import or a key to save: never in argv, where a process list would show it.
	stdin?: string;
}

export interface CrewRunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut?: true;
}

export type CrewRunner = (args: string[], options?: CrewRunOptions) => Promise<CrewRunResult>;

export interface WorktreeRow {
	ref: string;
	path: string;
	dev_running: boolean;
	installing: boolean;
}

export interface ProjectRow {
	name: string;
	path: string;
	mode: string;
}

interface CheckOptions {
	wait?: boolean;
}

const parseArray = <T>(json: string, isRow: (value: unknown) => value is T): T[] => {
	const parsed = JSON.parse(json) as unknown;

	if (!Array.isArray(parsed)) {
		throw new Error('expected a JSON array from crew');
	}

	return parsed.filter(isRow);
};

const isWorktreeRow = (value: unknown): value is WorktreeRow =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as WorktreeRow).ref === 'string' &&
	typeof (value as WorktreeRow).path === 'string';

const isProjectRow = (value: unknown): value is ProjectRow =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as ProjectRow).name === 'string' &&
	typeof (value as ProjectRow).path === 'string';

export const parseWorktrees = (json: string): WorktreeRow[] => {
	// Kept checks (check/<project>) are crew's own verification targets, not places to work.
	return parseArray(json, isWorktreeRow).filter((row) => !row.ref.startsWith('check/'));
};

export const parseProjects = (json: string): ProjectRow[] => {
	return parseArray(json, isProjectRow);
};

export interface ChatRow {
	id: string;
	dir: string;
	name: string;
}

const isChatRow = (value: unknown): value is ChatRow =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as ChatRow).id === 'string' &&
	typeof (value as ChatRow).dir === 'string';

export const parseChats = (json: string): ChatRow[] => parseArray(json, isChatRow);

// A plain session joins the list like a worktree: it is named by the developer's name for it, else
// "chat"; it runs in its folder with nothing of crew's.
export const toChatInfo = (row: ChatRow): WorktreeInfo => ({
	ref: `${CHAT_WORKSPACE}/${row.id}`,
	label: row.name?.trim() || CHAT_WORKSPACE,
	branch: '',
	cwd: row.dir,
	dirs: [],
	isPinned: false,
	isChat: true,
});

export interface ToWorktreeInfoParams {
	row: WorktreeRow;
	projects: ProjectRow[];
	branch: string;
}

export const toWorktreeInfo = ({ row, projects, branch }: ToWorktreeInfoParams): WorktreeInfo => {
	// Same rule as `crew claude`: several projects start in the root, a single one in its checkout.
	const singleProject = projects.length === 1 ? projects[0] : undefined;

	return {
		ref: row.ref,
		label: row.ref,
		branch,
		cwd: singleProject ? singleProject.path : row.path,
		dirs: singleProject ? [] : projects.map((project) => project.path),
		isPinned: false,
	};
};

export const crewBinary = (): string => process.env.CREW_BIN || 'crew';

// Past this after the group's SIGTERM, whatever is left gets SIGKILL.
const KILL_GRACE_MS = 2_000;

// Signals crew and everything it started: a child that outlives crew (a package manager, a server
// it waits on) holds stdout open, and the read would wait on it long past the timeout.
const killGroup = (pid: number, signal: NodeJS.Signals): void => {
	try {
		process.kill(-pid, signal);
	} catch {
		// Already gone.
	}
};

export const spawnRunner: CrewRunner = async (args, options) => {
	const stdin = options?.stdin;
	const crewProcess = Bun.spawn([crewBinary(), ...args], {
		cwd: options?.cwd,
		stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
		stdout: 'pipe',
		stderr: 'pipe',
		// Its own process group, so a timeout reaches the children too.
		detached: true,
	});
	let timedOut = false;
	let graceTimer: ReturnType<typeof setTimeout> | null = null;
	const killTimer = options?.timeoutMs
		? setTimeout(() => {
				timedOut = true;
				killGroup(crewProcess.pid, 'SIGTERM');
				graceTimer = setTimeout(() => killGroup(crewProcess.pid, 'SIGKILL'), KILL_GRACE_MS);
			}, options.timeoutMs)
		: null;
	const [stdout, stderr, code] = await Promise.all([
		new Response(crewProcess.stdout).text(),
		new Response(crewProcess.stderr).text(),
		crewProcess.exited,
	]);

	if (killTimer) {
		clearTimeout(killTimer);
	}

	if (graceTimer) {
		clearTimeout(graceTimer);
	}

	return { code, stdout, stderr, ...(timedOut ? { timedOut: true as const } : {}) };
};

// Started and let go: crew replaces (or removes) the process answering, so nothing waits on it. Its
// own process group, so stopping this server does not take it down halfway.
export type CrewStarter = (args: string[]) => void;

export const startDetached: CrewStarter = (args) => {
	const crewProcess = Bun.spawn([crewBinary(), ...args], {
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
		detached: true,
	});

	crewProcess.unref();
};

export type GitBranch = (path: string) => Promise<string>;

export const readGitBranch: GitBranch = async (path) => {
	const gitProcess = Bun.spawn(['git', '-C', path, 'branch', '--show-current'], {
		stdout: 'pipe',
		stderr: 'ignore',
	});
	const output = await new Response(gitProcess.stdout).text();

	await gitProcess.exited;

	return output.trim();
};

export class CrewAdapter {
	constructor(
		private run: CrewRunner = spawnRunner,
		private readBranch: GitBranch = readGitBranch,
	) {}

	private async runJson(args: string[]): Promise<string> {
		log.debug('crew', { args });

		const result = await this.run([...args, '--json']);

		if (result.code !== 0) {
			throw new Error(
				`crew ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
			);
		}

		return result.stdout;
	}

	async listWorktrees(): Promise<WorktreeInfo[]> {
		const rows = parseWorktrees(await this.runJson(['ls', 'worktrees']));
		const infos = await Promise.all(
			rows.map(async (row) => {
				try {
					const projects = parseProjects(await this.runJson(['show', row.ref]));
					const branch = projects[0] ? await this.readBranch(projects[0].path) : '';

					return toWorktreeInfo({ row, projects, branch });
				} catch (error) {
					// A single broken checkout is left out so it never freezes the list.
					log.warn('worktree skipped', { ref: row.ref, error: String(error) });

					return null;
				}
			}),
		);

		return [
			...infos.filter((info): info is WorktreeInfo => info !== null),
			...(await this.listChats()),
		];
	}

	// An older crew has no chats: none, never a broken list.
	private async listChats(): Promise<WorktreeInfo[]> {
		try {
			return parseChats(await this.runJson(['ls', 'chats'])).map(toChatInfo);
		} catch (error) {
			log.warn('chats not listed', { error: String(error) });

			return [];
		}
	}

	async fetchOrientation(ref: string): Promise<string> {
		// A plain session gets no crew orientation; Voice OS's own context is added to every session.
		if (isChatRef(ref)) {
			return '';
		}

		const result = await this.run(['start', ref]);

		if (result.code !== 0) {
			throw new Error(`crew start ${ref} failed: ${result.stderr.trim()}`);
		}

		return result.stdout;
	}

	async readDevRoutes(): Promise<RouteRow[]> {
		return parseRouteRows(await this.runJson(['dev', 'status']));
	}

	async checkServers(ref: string, { wait = false }: CheckOptions = {}): Promise<CheckRow[]> {
		// --wait watches until each server decides or a minute passes.
		const args = ['dev', 'check', ref, '--json', ...(wait ? ['--wait'] : [])];

		log.debug('crew', { args });

		const result = await this.run(args);

		// crew exits 1 when a server fails: a verdict, not an error, so the JSON is read either way.
		if (result.code !== 0 && result.code !== 1) {
			throw new Error(
				`crew dev check ${ref} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
			);
		}

		return parseCheckRows(result.stdout);
	}

	async readFixPrompt(ref: string, timeoutMs: number): Promise<string> {
		// Without a recorded failure crew runs a full verify first, hence the deadline.
		const result = await this.run(['fix', ref, '--print'], { timeoutMs });

		if (result.code !== 0 || !result.stdout.trim()) {
			throw new Error(
				`crew fix ${ref} --print failed: ${result.stderr.trim() || `exit ${result.code}`}`,
			);
		}

		return result.stdout;
	}

	async runDev(ref: string, action: 'start' | 'stop' | 'restart' | 'status'): Promise<string> {
		const result = await this.run(['dev', action, ref, '--json']);

		if (result.code !== 0) {
			throw new Error(`crew dev ${action} ${ref} failed: ${result.stderr.trim()}`);
		}

		return result.stdout;
	}
}
