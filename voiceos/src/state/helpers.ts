import type { Observation, Session, Stamped, State, StreamItem } from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';

export const STREAM_ITEMS_KEPT = 400;

const REQUESTS_KEPT = 3;
const MAX_REQUEST_CHARS = 200;

export const withoutEffects = (state: State): ReducerResult => ({ state, effects: [] });

export const readLabel = (state: State, ref: string): string => state.sessions[ref]?.label ?? ref;

export const updateSession = (
	state: State,
	ref: string,
	patch: (session: Session) => Session,
): State => {
	const current = state.sessions[ref];

	if (!current) {
		return state;
	}

	return { ...state, sessions: { ...state.sessions, [ref]: patch(current) } };
};

export const pushStreamItem = (session: Session, item: StreamItem): Session => {
	const stream = [...session.stream, item];

	return {
		...session,
		stream: stream.length > STREAM_ITEMS_KEPT ? stream.slice(-STREAM_ITEMS_KEPT) : stream,
	};
};

export interface CreateStreamItemParams {
	observation: Observation;
	id: string;
	at: number;
}

export const createStreamItem = ({
	observation,
	id,
	at,
}: CreateStreamItemParams): StreamItem | null => {
	switch (observation.type) {
		case 'assistant_text':
			return { id, at, kind: 'text', text: observation.text };
		case 'tool':
			return { id, at, kind: 'tool', name: observation.name, summary: observation.summary };
		case 'tool_result':
			return { id, at, kind: 'tool_result', ok: observation.ok, summary: observation.summary };
		case 'diff':
			return { id, at, kind: 'diff', filePath: observation.filePath, lines: observation.lines };
		default:
			return null;
	}
};

export const truncateText = (text: string, maxLength: number): string =>
	text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;

export interface SendNowParams {
	state: State;
	ref: string;
	text: string;
	note?: string;
	isSpoken?: boolean;
	itemId: string;
	at: number;
}

export const sendNow = ({
	state,
	ref,
	text,
	note,
	isSpoken = false,
	itemId,
	at,
}: SendNowParams): ReducerResult => {
	// The note goes to the worker only: the stream records what the developer said.
	const next = updateSession(state, ref, (session) =>
		pushStreamItem(
			{
				...session,
				status: 'running',
				needsUser: null,
				voiceTurnAt: isSpoken ? at : null,
				isFresh: false,
				requests: [...session.requests, { text: truncateText(text, MAX_REQUEST_CHARS), at }].slice(
					-REQUESTS_KEPT,
				),
			},
			{ id: itemId, at, kind: 'user', text },
		),
	);

	return { state: next, effects: [{ type: 'worker_send', ref, text, ...(note ? { note } : {}) }] };
};

export const startWorker = (state: State, ref: string): ReducerResult => {
	const effects: Effect[] = [{ type: 'worker_start', ref }];

	return {
		state: updateSession(state, ref, (session) => ({
			...session,
			status: 'starting',
			error: null,
			isFresh: true,
		})),
		effects,
	};
};

export const dispatchQueueHead = (state: State, ref: string, stamped: Stamped): ReducerResult => {
	// The only place a queued message leaves the queue, so cancel_queued can never race a send.
	const [head, ...remainingQueue] = state.sessions[ref]?.queue ?? [];

	if (!head) {
		return withoutEffects(state);
	}

	const dequeued = updateSession(state, ref, (session) => ({ ...session, queue: remainingQueue }));

	return sendNow({
		state: dequeued,
		ref,
		text: head.text,
		note: head.note,
		isSpoken: head.isFollowUp === true || head.isSpoken === true,
		itemId: `${stamped.id}:q`,
		at: stamped.at,
	});
};
