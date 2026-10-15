// The asking session's card for a request, patched from wherever its fate is decided: the request's
// own reducer, and the queue that delivers or drops a tell. A leaf: helpers.ts imports it.
import type { PeerFrom, QueuedMessage, State, StreamItem } from '../shared/protocol.js';

type AskCard = Extract<StreamItem, { kind: 'session_ask' }>;

export type CardPatch = Partial<
	Pick<AskCard, 'status' | 'answer' | 'files' | 'read' | 'settledAt'>
>;

export const NOT_DELIVERED = 'not delivered: it left the queue before the session started on it';

export const cardId = (requestId: string): string => `peer:${requestId}:asker`;

const patchWhere = (
	state: State,
	ref: string,
	requestId: string,
	isPatched: (card: AskCard) => boolean,
	patch: CardPatch,
): State => {
	const session = state.sessions[ref];

	if (!session) {
		return state;
	}

	const id = cardId(requestId);
	const stream = session.stream.map((item) =>
		item.id === id && item.kind === 'session_ask' && isPatched(item) ? { ...item, ...patch } : item,
	);

	return { ...state, sessions: { ...state.sessions, [ref]: { ...session, stream } } };
};

export const patchCard = (state: State, ref: string, requestId: string, patch: CardPatch): State =>
	patchWhere(state, ref, requestId, () => true, patch);

// A tell or allowed work reached its session: the card that waited on it says so.
export const markDelivered = (state: State, from: PeerFrom | undefined): State =>
	from?.requestId
		? patchWhere(state, from.ref, from.requestId, (card) => card.status === 'queued', {
				status: 'delivered',
			})
		: state;

// Peer messages that left a queue unsent (cancelled, interrupted, the session stopped or removed):
// their cards stop saying Queued.
const settleDroppedPeers = (state: State, dropped: QueuedMessage[], at: number): State =>
	dropped.reduce(
		(current, message) =>
			message.from?.requestId
				? patchWhere(
						current,
						message.from.ref,
						message.from.requestId,
						(card) => card.status === 'queued',
						{
							status: 'failed',
							answer: NOT_DELIVERED,
							settledAt: at,
						},
					)
				: current,
		state,
	);

const isPeerMessage = (message: QueuedMessage): boolean => Boolean(message.from?.requestId);

// Runs after every input: a peer message that left its queue was delivered (sendNow marked its card)
// or dropped, whichever of the many ways a queue is emptied did it.
export const settleLeftQueues = (before: State, after: State, at: number): State => {
	const dropped = Object.entries(before.sessions).flatMap(([ref, session]) => {
		const now = after.sessions[ref]?.queue;

		if (now === session.queue) {
			return [];
		}

		const kept = new Set((now ?? []).map((message) => message.id));

		return session.queue.filter((message) => isPeerMessage(message) && !kept.has(message.id));
	});

	return dropped.length ? settleDroppedPeers(after, dropped, at) : after;
};
