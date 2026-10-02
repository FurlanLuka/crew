// What the Set up pages read out of crew's --json, pure: the import plan, the bases a new worktree
// branches from, and what a removal costs. Pinned against crew's goldens in readers.spec.ts.
import type { CrewDryRun } from './types.js';
import { countOf } from '../count.js';

export interface PlanRow {
	kind: 'project' | 'workspace';
	name: string;
	status: string;
	detail: string;
}

// crew import - --plan --json: one row per project and workspace with what an import would do.
export const readPlan = (json: unknown): PlanRow[] => {
	const rows = Array.isArray(json)
		? json
		: json && typeof json === 'object'
			? [
					...((json as { projects?: unknown[] }).projects ?? []).map((row) => ({
						kind: 'project',
						...(row as object),
					})),
					...((json as { workspaces?: unknown[] }).workspaces ?? []).map((row) => ({
						kind: 'workspace',
						...(row as object),
					})),
				]
			: [];

	return rows.flatMap((raw): PlanRow[] => {
		if (!raw || typeof raw !== 'object') {
			return [];
		}

		const row = raw as Record<string, unknown>;
		const kind = row.kind === 'workspace' || row.type === 'workspace' ? 'workspace' : 'project';

		return [
			{
				kind,
				name: String(row.name ?? ''),
				status: String(row.status ?? row.state ?? row.action ?? ''),
				detail: String(row.detail ?? row.reason ?? row.path ?? ''),
			},
		];
	});
};

// crew dev logs / setup logs --json: the log as clean lines (crew strips the terminal's escape
// sequences), shown as text.
export const readLogText = (json: unknown): string => {
	const lines = json && typeof json === 'object' ? (json as { lines?: unknown }).lines : null;

	return Array.isArray(lines) ? lines.map(String).join('\n') : '';
};

export interface BaseRow {
	project: string;
	base: string;
	behind: number | null;
	error: string | null;
}

// crew ls bases <ws> --json: each project's base branch and how far behind origin it is.
export const readBases = (json: unknown): BaseRow[] =>
	(Array.isArray(json) ? json : []).flatMap((raw): BaseRow[] => {
		if (!raw || typeof raw !== 'object') {
			return [];
		}

		const row = raw as Record<string, unknown>;
		// -1: crew could not compare (no fetch).
		const behind = typeof row.behind === 'number' && row.behind >= 0 ? row.behind : null;
		const error = typeof row.error === 'string' && row.error ? row.error : null;

		return [
			{
				project: String(row.project ?? row.name ?? ''),
				base: String(row.base ?? row.branch ?? 'main'),
				behind,
				error,
			},
		];
	});

export const formatBytes = (bytes: number): string => {
	if (bytes >= 1e9) {
		return `${(bytes / 1e9).toFixed(1)} GB`;
	}

	return bytes >= 1e6
		? `${Math.round(bytes / 1e6)} MB`
		: `${Math.max(1, Math.round(bytes / 1e3))} KB`;
};

interface CostRow {
	label: string;
	detail: string;
}

// A dry run's checkouts, said as what each loses: uncommitted files, commits not on its base, its
// size. The checkout itself goes to the trash; commits stay in git's reflog.
export const describeCost = (json: unknown): CostRow[] => {
	const doc = (json && typeof json === 'object' ? json : {}) as Partial<CrewDryRun>;

	return (doc.checkouts ?? []).map((checkout) => ({
		label: `${checkout.ref} · ${checkout.project}`,
		detail: checkout.direct
			? 'your own checkout: left alone'
			: checkout.missing
				? 'already gone'
				: [
						checkout.uncommitted
							? countOf(checkout.uncommitted, 'uncommitted file')
							: 'nothing uncommitted',
						checkout.commits ? `${countOf(checkout.commits, 'commit')} not on its base` : '',
						checkout.size_bytes ? formatBytes(checkout.size_bytes) : '',
					]
						.filter(Boolean)
						.join(' · '),
	}));
};
