import type { WorktreeInfo } from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { parseCheckRows, parseRouteRows, type CheckRow, type RouteRow } from '../dev/servers.js';

const log = createLogger('crew');

interface CrewRunOptions {
	cwd?: string;
	timeoutMs?: number;
}

export interface CrewRunResult {
	code: number;
	stdout: string;
	stderr: string;
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

export const spawnRunner: CrewRunner = async (args, options) => {
	const binary = process.env.CREW_BIN || 'crew';
	const crewProcess = Bun.spawn([binary, ...args], {
		cwd: options?.cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const killTimer = options?.timeoutMs
		? setTimeout(() => crewProcess.kill(), options.timeoutMs)
		: null;
	const [stdout, stderr, code] = await Promise.all([
		new Response(crewProcess.stdout).text(),
		new Response(crewProcess.stderr).text(),
		crewProcess.exited,
	]);

	if (killTimer) {
		clearTimeout(killTimer);
	}

	return { code, stdout, stderr };
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
					// A single broken checkout is left out so it never freezes the grid.
					log.warn('worktree skipped', { ref: row.ref, error: String(error) });

					return null;
				}
			}),
		);

		return infos.filter((info): info is WorktreeInfo => info !== null);
	}

	async fetchOrientation(ref: string): Promise<string> {
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
