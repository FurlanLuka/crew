// Where a running turn shows it is at work, pure. A tool call in progress shows it on its own line
// (dots and its clock), the reply arriving has its caret, and only quiet thinking and waiting on you
// get a line at the foot of the stream: nothing is said twice.
import type { Session } from '../shared/protocol.js';

export type WorkingState =
	| { kind: 'thinking'; since: number | null }
	| { kind: 'tool'; itemId: string; since: number }
	| { kind: 'waiting' }
	| null;

export const readWorkingState = (session: Session, hasAsk: boolean): WorkingState => {
	if (session.status === 'blocked' || hasAsk) {
		return { kind: 'waiting' };
	}

	// Compaction has its own line, with its own clock; a reply arriving has its caret.
	if (session.status !== 'running' || session.compactingSince !== null || session.draft) {
		return null;
	}

	const last = session.stream.at(-1);

	return last?.kind === 'tool'
		? { kind: 'tool', itemId: last.id, since: last.at }
		: { kind: 'thinking', since: session.requests.at(-1)?.at ?? null };
};
