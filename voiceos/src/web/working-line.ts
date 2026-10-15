// The line at the foot of a session's stream while a turn runs, pure: what it is doing (thinking,
// a tool, writing) and since when, or that it waits on you. Through quiet thinking and long tool
// calls too, which a streaming caret alone never showed.
import type { Session } from '../shared/protocol.js';

export type WorkingLine =
	| { kind: 'working'; what: string; since: number | null }
	| { kind: 'waiting' }
	| null;

const MAX_WHAT = 60;

const clip = (text: string): string =>
	text.length > MAX_WHAT ? `${text.slice(0, MAX_WHAT - 1)}…` : text;

// A tool's summary is a lowercase action ("run pnpm test", "read src/app.ts"): said as now happening.
const describeTool = (summary: string): string =>
	summary.startsWith('run ')
		? `Running ${clip(summary.slice('run '.length))}`
		: clip(`${summary.charAt(0).toUpperCase()}${summary.slice(1)}`);

export const readWorkingLine = (session: Session, hasAsk: boolean): WorkingLine => {
	if (session.status === 'blocked' || hasAsk) {
		return { kind: 'waiting' };
	}

	// Compaction has its own line, with its own clock.
	if (session.status !== 'running' || session.compactingSince !== null) {
		return null;
	}

	const since = session.requests.at(-1)?.at ?? null;

	if (session.draft) {
		return { kind: 'working', what: 'Writing', since };
	}

	const last = session.stream.at(-1);

	return {
		kind: 'working',
		what: last?.kind === 'tool' ? describeTool(last.summary) : 'Thinking',
		since,
	};
};
