import type { Observation, Session, Stamped, State, StreamItem } from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { readShownText } from '../shared/spoken-tags.js';

// Withdrawn side questions remembered, so a late answer to one is never said or queued.
export const WITHDRAWN_KEPT = 20;

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
			// The page shows the message without its spoken line (restored history included).
			return { id, at, kind: 'text', text: readShownText(observation.text) };
		case 'tool':
			return { id, at, kind: 'tool', name: observation.name, summary: observation.summary };
		case 'tool_result':
			return { id, at, kind: 'tool_result', ok: observation.ok, summary: observation.summary };
		case 'diff':
			return { id, at, kind: 'diff', filePath: observation.filePath, lines: observation.lines };
		case 'image':
			return { id, at, kind: 'image', name: observation.name, alt: observation.alt };
		case 'doc':
			return { id, at, kind: 'doc', url: observation.url, title: observation.title };
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
	// An instruction: this turn's end is reported aloud.
	reportOwed?: boolean;
	// Which message this turn works on (its queue id, or the send's id when sent at once).
	sendId?: string;
}

export const sendNow = ({
	state,
	ref,
	text,
	note,
	isSpoken = false,
	itemId,
	at,
	reportOwed = false,
	sendId,
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
				reportOwed,
				spokenInTurn: [],
				currentSendId: sendId ?? itemId,
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
		reportOwed: head.reportOwed === true,
		sendId: head.id,
		itemId: `${stamped.id}:q`,
		at: stamped.at,
	});
};

interface PushNoticeParams {
	state: State;
	ref: string;
	text: string;
	stamped: Stamped;
	// Several notices from one input need their own ids.
	suffix: string;
}

export const pushNotice = ({ state, ref, text, stamped, suffix }: PushNoticeParams): State => {
	return updateSession(state, ref, (session) =>
		pushStreamItem(session, {
			id: `${stamped.id}:${suffix}`,
			at: stamped.at,
			kind: 'notice',
			text,
		}),
	);
};

// How the same words are recognised when said twice: case and spacing do not count.
export const normalizeSaid = (text: string): string =>
	text.trim().replace(/\s+/g, ' ').toLowerCase();

export const pointLastSpokenAt = (state: State, from: string, to: string): State =>
	// The developer's words moved into another carrier (a held switch or an aside became a message, an
	// aside became a switch): a continuation or a take-back still finds them.
	state.lastSpokenSend?.id === from
		? { ...state, lastSpokenSend: { ...state.lastSpokenSend, id: to } }
		: state;

// A doc linked again, or the same picture shown again, adds no second line: live, and when a
// history is restored.
export const isShownAlready = (stream: StreamItem[], observation: Observation): boolean => {
	switch (observation.type) {
		case 'doc':
			return stream.some((item) => item.kind === 'doc' && item.url === observation.url);
		case 'image': {
			// Within the turn: the same picture asked for again later is shown again.
			const turnStart = stream.findLastIndex((item) => item.kind === 'user');

			return stream
				.slice(turnStart + 1)
				.some((item) => item.kind === 'image' && item.name === observation.name);
		}
		default:
			return false;
	}
};
