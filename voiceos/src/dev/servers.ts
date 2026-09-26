import type { DevServer, DevServerState } from '../shared/protocol.js';
import { NUMBER_WORDS } from '../shared/spoken.js';

export interface CheckRow {
	// One row of `crew dev check --json`: what crew saw of a server, not a verdict.
	project: string;
	server: string;
	port: number;
	alive: boolean;
	listening: boolean;
	referenced: boolean;
	detail?: string;
}

export interface RouteRow {
	// One row of `crew dev status --json`.
	worktree: string;
	server_name: string;
	url: string;
}

const isCheckRow = (value: unknown): value is CheckRow =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as CheckRow).server === 'string' &&
	typeof (value as CheckRow).alive === 'boolean' &&
	typeof (value as CheckRow).listening === 'boolean';

const isRouteRow = (value: unknown): value is RouteRow =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as RouteRow).worktree === 'string' &&
	typeof (value as RouteRow).server_name === 'string';

const parseRows = <T>(json: string, isRow: (value: unknown) => value is T): T[] => {
	const parsed = JSON.parse(json) as unknown;

	if (!Array.isArray(parsed)) {
		throw new Error('expected a JSON array from crew');
	}

	return parsed.filter(isRow);
};

export const parseCheckRows = (json: string): CheckRow[] => parseRows(json, isCheckRow);
export const parseRouteRows = (json: string): RouteRow[] => parseRows(json, isRouteRow);

export const toServerState = (row: CheckRow): DevServerState => {
	if (!row.alive) {
		return 'died';
	}

	// Running without listening fails only when something points at it; otherwise it is a worker.
	if (!row.listening && row.referenced) {
		return 'not listening';
	}

	return 'running';
};

export interface ToServersParams {
	ref: string;
	rows: CheckRow[];
	routes: RouteRow[];
}

export const toServers = ({ ref, rows, routes }: ToServersParams): DevServer[] => {
	return rows.map((row) => ({
		name: row.server,
		port: row.port,
		url:
			routes.find((route) => route.worktree === ref && route.server_name === row.server)?.url ??
			null,
		state: toServerState(row),
		detail: row.detail ?? null,
	}));
};

const filterFailing = (servers: DevServer[]) =>
	servers.filter((server) => server.state === 'died' || server.state === 'not listening');

export const describeTransitions = (
	previous: DevServer[] | undefined,
	next: DevServer[],
): string[] => {
	if (!previous) {
		return [];
	}

	// A server the developer stopped leaves the list instead, so it is never a crash.
	const wasRunning = new Set(
		previous.filter((server) => server.state === 'running').map((server) => server.name),
	);

	return filterFailing(next)
		.filter((server) => wasRunning.has(server.name))
		.map((server) => server.name);
};

export interface Suspect {
	name: string;
	since: number;
}

export const NOT_LISTENING_GRACE_MS = 60_000;

export interface ConfirmServersDownParams {
	suspects: Suspect[];
	previous: DevServer[] | undefined;
	next: DevServer[];
	now: number;
}

interface ConfirmServersDownResult {
	announce: string[];
	suspects: Suspect[];
}

export const confirmServersDown = ({
	suspects,
	previous,
	next,
	now,
}: ConfirmServersDownParams): ConfirmServersDownResult => {
	// A terminal restart passes through moments where servers look down; that must not sound like a crash.
	const failingStates = new Map(filterFailing(next).map((server) => [server.name, server.state]));
	const carried = suspects.filter((suspect) => failingStates.has(suspect.name));
	const knownNames = new Set(carried.map((suspect) => suspect.name));
	const freshSuspects = describeTransitions(previous, next)
		.filter((name) => !knownNames.has(name))
		.map((name) => ({ name, since: now }));
	// A dead process is confirmed on the next look; a silent port after the grace (a big app's first compile).
	const announce = carried
		.filter(
			(suspect) =>
				failingStates.get(suspect.name) === 'died' || now - suspect.since >= NOT_LISTENING_GRACE_MS,
		)
		.map((suspect) => suspect.name);

	return {
		announce,
		suspects: [...carried.filter((suspect) => !announce.includes(suspect.name)), ...freshSuspects],
	};
};

export type StartReply =
	| { kind: 'up' }
	| { kind: 'failing'; servers: string[] }
	| { kind: 'stopped' };

export const decideStartReply = (servers: DevServer[] | undefined): StartReply => {
	if (!servers || servers.length === 0) {
		return { kind: 'stopped' };
	}

	const brokenNames = filterFailing(servers).map((server) => server.name);

	return brokenNames.length > 0 ? { kind: 'failing', servers: brokenNames } : { kind: 'up' };
};

export const joinNames = (names: string[]): string => {
	if (names.length <= 1) {
		return names[0] ?? '';
	}

	return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

const countInWords = (amount: number): string => {
	return NUMBER_WORDS[amount] ?? String(amount);
};

interface VerdictLine {
	text: string;
	failing: string[];
}

export const formatVerdictLine = (servers: DevServer[]): VerdictLine => {
	// Spoken without the worktree's name: it is added when that worktree is not on screen.
	const diedNames = servers
		.filter((server) => server.state === 'died')
		.map((server) => server.name);
	const silentNames = servers
		.filter((server) => server.state === 'not listening')
		.map((server) => server.name);
	const brokenNames = [...diedNames, ...silentNames];

	if (servers.length === 0) {
		return { text: 'no dev servers came up.', failing: [] };
	}

	if (brokenNames.length === 0) {
		return {
			text:
				servers.length === 1
					? 'the dev server is up.'
					: `all ${countInWords(servers.length)} dev servers are up.`,
			failing: [],
		};
	}

	const parts = [
		diedNames.length ? `${joinNames(diedNames)} died` : '',
		silentNames.length
			? `${joinNames(silentNames)} ${silentNames.length === 1 ? 'is' : 'are'} not answering`
			: '',
	].filter(Boolean);

	return { text: `${parts.join(', and ')}. Want Claude to fix it?`, failing: brokenNames };
};

interface BuildFallbackFixPromptParams {
	ref: string;
	servers: DevServer[];
}

export const buildFallbackFixPrompt = ({ ref, servers }: BuildFallbackFixPromptParams): string => {
	// Used when crew's own fix prompt cannot be produced in time.
	const lines = filterFailing(servers).map(
		(server) =>
			`- ${server.name} (port ${server.port}): ${server.state}${server.detail ? ` — ${server.detail}` : ''}`,
	);

	return [
		`The dev servers of ${ref} are failing:`,
		...lines,
		'',
		`Find out why and fix it. Read the logs with crew dev logs ${ref} <server> --lines=80, restart with crew dev restart ${ref}, and confirm with crew dev check ${ref} --wait.`,
	].join('\n');
};
