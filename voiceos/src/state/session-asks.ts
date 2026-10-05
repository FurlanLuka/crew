// One session asking, telling or requesting a secret from another. The main's reducer decides it
// all — which session the name means, the limits, the cards on both pages — and the target's machine
// does only what it is told: run a read-only copy, or copy a secret.
import { listActiveInOrder } from '../shared/active.js';
import { readSessionLabel } from '../shared/machines.js';
import { isSetupRef, readMachine } from '../shared/machine-ref.js';
import { buildPeerNote, describePeerAskAloud } from '../shared/peer-note.js';
import type {
	Attachment,
	Input,
	PeerAsk,
	PeerRequest,
	PeerRequestKind,
	PeerRequestStatus,
	Session,
	Stamped,
	State,
	StreamItem,
} from '../shared/protocol.js';
import { readShownText } from '../shared/spoken-tags.js';
import { findRefsByName } from '../router/refs.js';
import { deliverSend } from './delivery.js';
import { pushStreamItem, updateSession, withoutEffects } from './helpers.js';
import type { Effect, ReducerResult } from './reducer.js';

// A few per turn: a session that keeps asking is stuck, and every ask costs a model call.
export const PEER_REQUESTS_PER_TURN = 3;
// The asker's tool call gives up at 190 s; the main settles anything still open a little later.
export const PEER_REQUEST_TTL_MS = 200_000;
// Waiting on the developer's Allow: long enough to come back to the desk.
export const PEER_ASK_TTL_MS = 15 * 60_000;
const LISTED_SESSIONS = 12;

export type AskTarget = { kind: 'one'; ref: string } | { kind: 'refused'; reason: string };

const listCandidates = (state: State, refs: string[]): string =>
	refs.map((ref) => `${readSessionLabel(state, ref)} (${ref})`).join('; ');

const findExactRef = (state: State, written: string, refs: string[]): string | null => {
	const trimmed = written.trim();

	return refs.find((ref) => ref === trimmed || readSessionLabel(state, ref) === trimmed) ?? null;
};

// The name as the asking Claude wrote it: the session on the asker's own machine first, as the
// developer means the machine they are looking at.
export const resolveAskTarget = (state: State, from: string, written: string): AskTarget => {
	const reachable = listActiveInOrder(state).filter((ref) => !isSetupRef(ref));
	const exact = findExactRef(state, written, reachable);
	const named = exact ? [exact] : findRefsByName(state, written, reachable);
	const onSameMachine = named.filter((ref) => readMachine(ref) === readMachine(from));
	const matches = onSameMachine.length > 0 ? onSameMachine : named;
	const others = reachable.filter((ref) => ref !== from).slice(0, LISTED_SESSIONS);

	if (matches.length === 0) {
		return {
			kind: 'refused',
			reason: `No active session is called "${written}". Active sessions: ${listCandidates(state, others) || 'none besides you'}. Call again with one of these, or ask the developer.`,
		};
	}

	if (matches.length > 1) {
		return {
			kind: 'refused',
			reason: `"${written}" matches several sessions: ${listCandidates(state, matches)}. Call again with the full name in brackets, or ask the developer which one.`,
		};
	}

	const [ref] = matches as [string];

	return ref === from
		? { kind: 'refused', reason: 'That is you: ask another session.' }
		: { kind: 'one', ref };
};

interface CheckLimitsParams {
	session: Session;
	kind: PeerRequestKind;
	to: string;
}

export const checkPeerLimits = ({ session, kind, to }: CheckLimitsParams): string | null => {
	if (session.peerRequestsInTurn >= PEER_REQUESTS_PER_TURN) {
		return `You already made ${PEER_REQUESTS_PER_TURN} requests to other sessions this turn. Go on with what you have, or ask the developer.`;
	}

	// The session whose message started this turn is not told back from it: two sessions must never
	// keep each other going while the developer is away.
	if (kind === 'tell' && session.turnFrom === to) {
		return 'This turn started with a message from that session: no message back from it. Tell the developer instead if it matters.';
	}

	return null;
};

const cardId = (id: string, role: 'asker' | 'asked'): string => `peer:${id}:${role}`;

interface PushCardParams {
	state: State;
	ref: string;
	id: string;
	role: 'asker' | 'asked';
	request: PeerRequestKind;
	peer: string;
	text: string;
	status: PeerRequestStatus;
	answer?: string;
	files?: Attachment[];
	at: number;
}

const pushCard = ({ state, ref, id, role, at, files, answer, ...card }: PushCardParams): State =>
	updateSession(state, ref, (session) =>
		pushStreamItem(session, {
			id: cardId(id, role),
			at,
			kind: 'session_ask',
			requestId: id,
			role,
			...card,
			...(answer ? { answer } : {}),
			...(files?.length ? { files } : {}),
		}),
	);

type SessionAskCard = Extract<StreamItem, { kind: 'session_ask' }>;
type CardUpdate = Partial<Pick<SessionAskCard, 'status' | 'answer' | 'files' | 'read'>>;

const updateCard = (state: State, ref: string, itemId: string, update: CardUpdate): State =>
	updateSession(state, ref, (session) => ({
		...session,
		stream: session.stream.map((item) =>
			item.id === itemId && item.kind === 'session_ask' ? { ...item, ...update } : item,
		),
	}));

const updateCards = (state: State, request: PeerRequest, update: CardUpdate): State =>
	updateCard(
		updateCard(state, request.from, cardId(request.id, 'asker'), update),
		request.to,
		cardId(request.id, 'asked'),
		update,
	);

const answerAsker = (ref: string, id: string, text: string, files: Attachment[] = []): Effect => ({
	type: 'session_ask_answered',
	ref,
	id,
	text,
	files,
});

const countRequest = (state: State, ref: string): State =>
	updateSession(state, ref, (session) => ({
		...session,
		peerRequestsInTurn: session.peerRequestsInTurn + 1,
	}));

const withRequest = (state: State, request: PeerRequest): State => ({
	...state,
	peerRequests: [...state.peerRequests, request],
});

const withoutRequest = (state: State, id: string): State => ({
	...state,
	peerRequests: state.peerRequests.filter((request) => request.id !== id),
});

type Requested = Extract<Input, { type: 'session_ask_requested' }>;

const refuse = (state: State, input: Requested, reason: string, at: number): ReducerResult => ({
	state: pushCard({
		state,
		ref: input.ref,
		id: input.id,
		role: 'asker',
		request: input.kind,
		peer: input.session,
		text: input.text,
		status: 'refused',
		answer: reason,
		at,
	}),
	effects: [answerAsker(input.ref, input.id, reason)],
});

interface OpenPeerAskParams {
	state: State;
	ask: PeerAsk;
}

const openPeerAsk = ({ state, ask }: OpenPeerAskParams): ReducerResult => ({
	state: { ...state, asks: [...state.asks, ask] },
	effects: [
		// Said wherever the developer is: it waits on them, and lapses if nobody answers.
		{
			type: 'speak',
			text: describePeerAskAloud(ask),
			source: 'alert',
			ref: ask.ref,
			isAsking: true,
		},
		{ type: 'expire_peer', key: ask.id, ms: PEER_ASK_TTL_MS },
	],
});

export const reduceSessionAskRequested = (
	state: State,
	input: Requested,
	stamped: Stamped,
): ReducerResult => {
	const asker = state.sessions[input.ref];

	if (!asker) {
		return withoutEffects(state);
	}

	const target = resolveAskTarget(state, input.ref, input.session);

	if (target.kind === 'refused') {
		return refuse(state, input, target.reason, stamped.at);
	}

	const to = target.ref;
	const limit = checkPeerLimits({ session: asker, kind: input.kind, to });

	if (limit) {
		return refuse(state, input, limit, stamped.at);
	}

	const fromLabel = readSessionLabel(state, input.ref);
	const toLabel = readSessionLabel(state, to);
	const counted = countRequest(state, input.ref);
	const card = {
		id: input.id,
		request: input.kind,
		text: input.text,
		at: stamped.at,
		...(input.files.length ? { files: input.files } : {}),
	};

	if (input.kind === 'tell') {
		const isIdle = state.sessions[to]?.status === 'idle';
		const delivered = deliverSend({
			state: pushCard({
				state: counted,
				ref: input.ref,
				role: 'asker',
				peer: toLabel,
				status: 'sent',
				...card,
			}),
			ref: to,
			text: input.text,
			note: buildPeerNote(fromLabel),
			...(input.files.length ? { attachments: input.files } : {}),
			isSpoken: false,
			stamped,
			from: { ref: input.ref, label: fromLabel },
		});

		return {
			state: delivered.state,
			effects: [
				...delivered.effects,
				answerAsker(
					input.ref,
					input.id,
					isIdle ? `Sent to ${toLabel}.` : `Queued for ${toLabel} after its current work.`,
				),
			],
		};
	}

	if (input.kind === 'secret') {
		const opened = openPeerAsk({
			state: pushCard({
				state: counted,
				ref: input.ref,
				role: 'asker',
				peer: toLabel,
				status: 'waiting_ok',
				...card,
			}),
			ask: {
				id: `${input.id}:ok`,
				ref: input.ref,
				at: stamped.at,
				kind: 'secret',
				to,
				fromLabel,
				toLabel,
				what: input.text,
				requestId: input.id,
			},
		});

		return {
			state: withRequest(opened.state, {
				id: input.id,
				kind: 'secret',
				from: input.ref,
				to,
				at: stamped.at,
			}),
			effects: [
				...opened.effects,
				answerAsker(
					input.ref,
					input.id,
					`Asked the developer to allow copying ${input.text} from ${toLabel}. If they do, a message tells you the path of a private temp file holding it.`,
				),
			],
		};
	}

	const asking = pushCard({
		state: pushCard({
			state: counted,
			ref: input.ref,
			role: 'asker',
			peer: toLabel,
			status: 'asking',
			...card,
		}),
		ref: to,
		role: 'asked',
		peer: fromLabel,
		status: 'asking',
		...card,
	});

	return {
		state: withRequest(asking, { id: input.id, kind: 'ask', from: input.ref, to, at: stamped.at }),
		effects: [
			{ type: 'session_fork', ref: to, id: input.id, fromLabel, question: input.text },
			{ type: 'expire_peer', key: input.id, ms: PEER_REQUEST_TTL_MS },
		],
	};
};

const describeFiles = (files: Attachment[]): string =>
	files.length ? ` (${files.length} file${files.length === 1 ? '' : 's'} attached)` : '';

type Settled = Extract<Input, { type: 'session_fork_settled' }>;

export const reduceSessionForkSettled = (
	state: State,
	input: Settled,
	stamped: Stamped,
): ReducerResult => {
	const request = state.peerRequests.find((pending) => pending.id === input.id);

	// Already settled (it timed out, or the link resent it): nothing waits for this any more.
	if (!request) {
		return withoutEffects(state);
	}

	const settled = withoutRequest(state, request.id);
	const toLabel = readSessionLabel(state, request.to);
	const fromLabel = readSessionLabel(state, request.from);

	if (input.status === 'answered') {
		return {
			state: updateCards(settled, request, {
				status: 'answered',
				answer: input.answer,
				...(input.files.length ? { files: input.files } : {}),
				...(input.read.length ? { read: input.read } : {}),
			}),
			effects: [
				answerAsker(
					request.from,
					request.id,
					`${toLabel} answered${describeFiles(input.files)}:\n\n${input.answer}`,
					input.files,
				),
			],
		};
	}

	if (input.status === 'needs_work') {
		const opened = openPeerAsk({
			state: updateCards(settled, request, { status: 'needs_work', answer: input.answer }),
			ask: {
				id: `${request.id}:ok`,
				ref: request.from,
				at: stamped.at,
				kind: 'work',
				to: request.to,
				fromLabel,
				toLabel,
				text: input.answer,
				requestId: request.id,
			},
		});

		return {
			state: opened.state,
			effects: [
				...opened.effects,
				answerAsker(
					request.from,
					request.id,
					`${toLabel} would have to run something to answer: ${input.answer}. I asked the developer; if they allow it, ${toLabel} does it and its answer comes to you as a message. It may never come.`,
				),
			],
		};
	}

	return {
		state: updateCards(settled, request, { status: 'failed', answer: input.answer }),
		effects: [answerAsker(request.from, request.id, `No answer from ${toLabel}: ${input.answer}.`)],
	};
};

// No answer in time (a remote that dropped and never came back): the asker hears that, once.
export const reducePeerRequestExpired = (state: State, key: string): ReducerResult => {
	const request = state.peerRequests.find((pending) => pending.id === key);

	if (!request) {
		return reducePeerAskLapsed(state, key);
	}

	const toLabel = readSessionLabel(state, request.to);

	return {
		state: updateCards(withoutRequest(state, key), request, {
			status: 'failed',
			answer: 'no answer in time',
		}),
		effects:
			request.kind === 'ask'
				? [answerAsker(request.from, request.id, `No answer from ${toLabel} in time.`)]
				: [],
	};
};

const findPeerAsk = (state: State, askId: string): PeerAsk | undefined =>
	state.asks.find(
		(ask): ask is PeerAsk => ask.id === askId && (ask.kind === 'work' || ask.kind === 'secret'),
	);

const closePeerAsk = (
	state: State,
	ask: PeerAsk,
	status: PeerRequestStatus,
	answer: string,
): State => {
	const rest = { ...state, asks: state.asks.filter((pending) => pending.id !== ask.id) };

	return updateCard(withoutRequest(rest, ask.requestId), ask.ref, cardId(ask.requestId, 'asker'), {
		status,
		answer,
	});
};

const reducePeerAskLapsed = (state: State, askId: string): ReducerResult => {
	const ask = findPeerAsk(state, askId);

	return ask
		? withoutEffects(closePeerAsk(state, ask, 'refused', 'nobody allowed it in time'))
		: withoutEffects(state);
};

const WORK_NOTE = (fromLabel: string): string =>
	`(Voice OS note — ${fromLabel} asked for this and the developer allowed it. Do it; your final reply goes back to ${fromLabel}.)`;

export const reduceAnswerPeer = (
	state: State,
	input: Extract<Input, { type: 'answer_peer' }>,
	stamped: Stamped,
): ReducerResult => {
	const ask = findPeerAsk(state, input.askId);

	if (!ask) {
		return withoutEffects(state);
	}

	if (!input.isApproved) {
		return withoutEffects(closePeerAsk(state, ask, 'refused', 'the developer said no'));
	}

	if (ask.kind === 'secret') {
		const rest = { ...state, asks: state.asks.filter((pending) => pending.id !== ask.id) };

		return {
			state: updateCard(rest, ask.ref, cardId(ask.requestId, 'asker'), {
				status: 'asking',
				answer: 'allowed: copying',
			}),
			effects: [
				{ type: 'secret_transfer', ref: ask.to, id: ask.requestId, what: ask.what, toRef: ask.ref },
				{ type: 'expire_peer', key: ask.requestId, ms: PEER_REQUEST_TTL_MS },
			],
		};
	}

	const closed = closePeerAsk(state, ask, 'sent', `allowed: queued for ${ask.toLabel}`);
	const delivered = deliverSend({
		state: closed,
		ref: ask.to,
		text: ask.text,
		note: WORK_NOTE(ask.fromLabel),
		isSpoken: false,
		stamped,
		from: { ref: ask.ref, label: ask.fromLabel },
		replyTo: ask.ref,
	});

	return {
		state: delivered.state,
		effects: [
			...delivered.effects,
			{
				type: 'speak',
				text: `Okay, ${ask.toLabel} will do it.`,
				source: 'kernel',
				priority: 'high',
			},
		],
	};
};

export const reduceSecretTransferred = (
	state: State,
	input: Extract<Input, { type: 'secret_transferred' }>,
	stamped: Stamped,
): ReducerResult => {
	const request = state.peerRequests.find((pending) => pending.id === input.id);

	if (!request) {
		return withoutEffects(state);
	}

	const settled = withoutRequest(state, request.id);
	const toLabel = readSessionLabel(state, request.to);
	const text = input.path
		? `The developer allowed a copy of ${toLabel}'s secret. It is in ${input.path} (readable only by you). Copy or source it from there; never print, echo or read its contents into this conversation.`
		: `The secret from ${toLabel} could not be copied: ${input.reason ?? 'unknown reason'}.`;
	const carded = updateCard(settled, request.from, cardId(request.id, 'asker'), {
		status: input.path ? 'answered' : 'failed',
		answer: input.path ? `copied to ${input.path}` : (input.reason ?? 'not copied'),
	});

	return deliverSend({
		state: carded,
		ref: request.from,
		text,
		note: buildPeerNote(toLabel),
		isSpoken: false,
		stamped,
		from: { ref: request.to, label: toLabel },
	});
};

// The work another session asked for ended: its final text goes back to that session. A turn cut
// off by the developer's follow-up hands the debt to the follow-up's turn.
export const settleReplyBack = (
	before: Session,
	state: State,
	text: string,
	stamped: Stamped,
): ReducerResult => {
	const owedTo = before.replyOwed;

	if (!owedTo || !state.sessions[owedTo]) {
		return withoutEffects(state);
	}

	const answer = readShownText(text).trim();

	if (!answer) {
		return withoutEffects(state);
	}

	const label = readSessionLabel(state, before.ref);

	return deliverSend({
		state,
		ref: owedTo,
		text: `${label} finished the work you asked for. Its reply:\n\n${answer}`,
		note: buildPeerNote(label),
		isSpoken: false,
		stamped,
		from: { ref: before.ref, label },
	});
};

// A follow-up cut the turn that owed the reply: the reply is owed by the follow-up's turn instead.
export const carryReplyOwed = (state: State, ref: string, owedTo: string): State =>
	updateSession(state, ref, (session) => {
		const [head, ...rest] = session.queue;

		return head ? { ...session, queue: [{ ...head, replyTo: owedTo }, ...rest] } : session;
	});
