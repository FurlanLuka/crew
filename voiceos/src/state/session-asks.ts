// One session asking, telling or requesting a secret from another. The main's reducer decides it
// all — which session the name means, the limits, the asker's card and the asked session's row — and
// the target's machine does only what it is told: run a read-only copy, or copy a secret.
import { listActiveInOrder } from '../shared/active.js';
import { readSessionLabel } from '../shared/machines.js';
import { isSetupRef, readMachine } from '../shared/machine-ref.js';
import { buildPeerNote, buildWorkNote, describePeerAskAloud } from '../shared/peer-note.js';
import type {
	Attachment,
	Input,
	PeerAsk,
	PeerRequest,
	PeerRequestKind,
	PeerRequestStatus,
	PeerRun,
	Session,
	Stamped,
	State,
} from '../shared/protocol.js';
import { readShownText } from '../shared/spoken-tags.js';
import { findRefsByName } from '../router/refs.js';
import { deliverSend } from './delivery.js';
import { pushStreamItem, sayRef, updateSession, withoutEffects } from './helpers.js';
import type { Effect, ReducerResult } from './reducer.js';
import { type CardPatch, cardId, patchCard } from './peer-cards.js';
import { patchPeerRun, settlePeerRun, settleRunsOf, startPeerRun } from './peer-runs.js';

// A few per turn: a session that keeps asking is stuck, and every ask costs a model call.
export const PEER_REQUESTS_PER_TURN = 3;
// The asker's tool call gives up at 190 s; the main settles anything still open a little later.
export const PEER_REQUEST_TTL_MS = 200_000;
// Waiting on the developer's Allow: long enough to come back to the desk.
export const PEER_ASK_TTL_MS = 15 * 60_000;
const LISTED_SESSIONS = 12;
// The developer's Allow for a request is its own ask, keyed beside the request.
const PEER_ASK_SUFFIX = ':ok';

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

interface PushCardParams {
	state: State;
	ref: string;
	id: string;
	request: PeerRequestKind;
	peer: string;
	peerRef?: string;
	text: string;
	status: PeerRequestStatus;
	answer?: string;
	files?: Attachment[];
	at: number;
}

const pushCard = ({ state, ref, id, at, files, answer, peerRef, ...card }: PushCardParams): State =>
	updateSession(state, ref, (session) =>
		pushStreamItem(session, {
			id: cardId(id),
			at,
			kind: 'session_ask',
			requestId: id,
			...card,
			...(peerRef ? { peerRef } : {}),
			...(answer ? { answer } : {}),
			...(files?.length ? { files } : {}),
		}),
	);

interface SettleParams {
	state: State;
	// The asker, the asked session, and the request between them.
	from: string;
	to: string;
	id: string;
	card: CardPatch;
	run: Pick<PeerRun, 'status'> & Partial<Pick<PeerRun, 'answer'>>;
	at: number;
}

// Every way a request ends: its card on the asking session and its row on the asked one, together.
const settleRequest = ({ state, from, to, id, card, run, at }: SettleParams): State =>
	settlePeerRun(patchCard(state, from, id, { ...card, settledAt: at }), to, id, run, at);

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
			text: describePeerAskAloud(ask, { from: sayRef(state, ask.ref), to: sayRef(state, ask.to) }),
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
		ref: input.ref,
		id: input.id,
		request: input.kind,
		peer: toLabel,
		peerRef: to,
		text: input.text,
		at: stamped.at,
		...(input.files.length ? { files: input.files } : {}),
	};

	if (input.kind === 'tell') {
		const isIdle = state.sessions[to]?.status === 'idle';
		// Always queued here: its delivery, now or after the session's current work, marks it.
		const delivered = deliverSend({
			state: pushCard({ state: counted, status: 'queued', ...card }),
			ref: to,
			text: input.text,
			note: buildPeerNote(fromLabel),
			...(input.files.length ? { attachments: input.files } : {}),
			isSpoken: false,
			stamped,
			from: { ref: input.ref, label: fromLabel, requestId: input.id },
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

	const run = { requestId: input.id, fromRef: input.ref, fromLabel, text: input.text };

	if (input.kind === 'secret') {
		const opened = openPeerAsk({
			state: startPeerRun(
				pushCard({ state: counted, status: 'waiting_ok', ...card }),
				to,
				{ ...run, kind: 'secret', status: 'waiting_ok' },
				stamped.at,
			),
			ask: {
				id: `${input.id}${PEER_ASK_SUFFIX}`,
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

	const asking = startPeerRun(
		pushCard({ state: counted, status: 'asking', ...card }),
		to,
		{ ...run, kind: 'ask', status: 'asking' },
		stamped.at,
	);

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
	const ends = { from: request.from, to: request.to, id: request.id, at: stamped.at };

	if (input.status === 'answered') {
		return {
			state: settleRequest({
				state: settled,
				...ends,
				card: {
					status: 'answered',
					answer: input.answer,
					...(input.files.length ? { files: input.files } : {}),
					...(input.read.length ? { read: input.read } : {}),
				},
				run: { status: 'answered', answer: input.answer },
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
		// The copy is done, but the request waits on the developer: neither side has settled.
		const waiting = patchPeerRun(
			patchCard(settled, request.from, request.id, { status: 'needs_work', answer: input.answer }),
			request.to,
			request.id,
			{ status: 'needs_work', answer: input.answer, step: null },
		);
		const opened = openPeerAsk({
			state: waiting,
			ask: {
				id: `${request.id}${PEER_ASK_SUFFIX}`,
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
		state: settleRequest({
			state: settled,
			...ends,
			card: { status: 'failed', answer: input.answer },
			run: { status: 'failed', answer: input.answer },
		}),
		effects: [answerAsker(request.from, request.id, `No answer from ${toLabel}: ${input.answer}.`)],
	};
};

// No answer in time (a remote that dropped and never came back): the asker hears that, once. A
// secret that never came is told as a copy that failed, as the asker was promised a message.
export const reducePeerRequestExpired = (
	state: State,
	key: string,
	stamped: Stamped,
): ReducerResult => {
	const request = state.peerRequests.find((pending) => pending.id === key);

	if (!request) {
		return reducePeerAskLapsed(state, key, stamped.at);
	}

	if (request.kind === 'secret') {
		return reduceSecretTransferred(
			state,
			{
				type: 'secret_transferred',
				ref: request.from,
				id: key,
				path: null,
				reason: 'no answer in time',
			},
			stamped,
		);
	}

	const toLabel = readSessionLabel(state, request.to);

	return {
		state: settleRequest({
			state: withoutRequest(state, key),
			from: request.from,
			to: request.to,
			id: request.id,
			at: stamped.at,
			card: { status: 'failed', answer: 'no answer in time' },
			run: { status: 'failed', answer: 'no answer in time' },
		}),
		effects: [answerAsker(request.from, request.id, `No answer from ${toLabel} in time.`)],
	};
};

const withoutAsk = (state: State, askId: string): State => ({
	...state,
	asks: state.asks.filter((pending) => pending.id !== askId),
});

const findPeerAsk = (state: State, askId: string): PeerAsk | undefined =>
	state.asks.find(
		(ask): ask is PeerAsk => ask.id === askId && (ask.kind === 'work' || ask.kind === 'secret'),
	);

const closePeerAsk = (state: State, ask: PeerAsk, answer: string, at: number): State =>
	settleRequest({
		state: withoutRequest(withoutAsk(state, ask.id), ask.requestId),
		from: ask.ref,
		to: ask.to,
		id: ask.requestId,
		at,
		card: { status: 'refused', answer },
		run: { status: 'refused', answer },
	});

// The developer's Allow ran out of time. Its request goes too, even when the ask itself went first
// (its machine removed), so nothing waits on it forever.
const reducePeerAskLapsed = (state: State, askId: string, at: number): ReducerResult => {
	const ask = findPeerAsk(state, askId);

	if (ask) {
		return withoutEffects(closePeerAsk(state, ask, 'nobody allowed it in time', at));
	}

	const requestId = askId.endsWith(PEER_ASK_SUFFIX)
		? askId.slice(0, -PEER_ASK_SUFFIX.length)
		: null;
	const request = state.peerRequests.find((pending) => pending.id === requestId);

	return request
		? withoutEffects(
				settleRequest({
					state: withoutRequest(state, request.id),
					from: request.from,
					to: request.to,
					id: request.id,
					at,
					card: { status: 'refused', answer: 'nobody allowed it in time' },
					run: { status: 'refused', answer: 'nobody allowed it in time' },
				}),
			)
		: withoutEffects(
				requestId
					? settleRunsOf(
							state,
							requestId,
							{ status: 'refused', answer: 'nobody allowed it in time' },
							at,
						)
					: state,
			);
};

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
		return withoutEffects(closePeerAsk(state, ask, 'the developer said no', stamped.at));
	}

	if (ask.kind === 'secret') {
		// Copying now: the card and the row both read as under way until the copy lands.
		const copying = patchPeerRun(
			patchCard(withoutAsk(state, ask.id), ask.ref, ask.requestId, { status: 'asking' }),
			ask.to,
			ask.requestId,
			{ status: 'asking' },
		);

		return {
			state: copying,
			effects: [
				{ type: 'secret_transfer', ref: ask.to, id: ask.requestId, what: ask.what, toRef: ask.ref },
				{ type: 'expire_peer', key: ask.requestId, ms: PEER_REQUEST_TTL_MS },
			],
		};
	}

	// Allowed: the work goes to the asked session's queue, and its card waits on the delivery.
	const allowed = settlePeerRun(
		patchCard(withoutRequest(withoutAsk(state, ask.id), ask.requestId), ask.ref, ask.requestId, {
			status: 'queued',
			answer: ask.text,
		}),
		ask.to,
		ask.requestId,
		{ status: 'queued' },
		stamped.at,
	);
	const delivered = deliverSend({
		state: allowed,
		ref: ask.to,
		text: ask.text,
		note: buildWorkNote(ask.fromLabel),
		isSpoken: false,
		stamped,
		from: { ref: ask.ref, label: ask.fromLabel, requestId: ask.requestId },
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

// The secret's result reaches the asker as a message from Voice OS: the asked session never said it.
const SECRET_SENDER = 'Voice OS';

export const reduceSecretTransferred = (
	state: State,
	input: Extract<Input, { type: 'secret_transferred' }>,
	stamped: Stamped,
): ReducerResult => {
	const request = state.peerRequests.find((pending) => pending.id === input.id);

	if (!request) {
		return withoutEffects(state);
	}

	const toLabel = readSessionLabel(state, request.to);
	const reason = input.reason ?? 'unknown reason';
	const text = input.path
		? `The developer allowed a copy of ${toLabel}'s secret. It is in ${input.path} (readable only by you). Copy or source it from there; never print, echo or read its contents into this conversation.`
		: `The secret from ${toLabel} could not be copied: ${reason}.`;
	// The card keeps the file's path (never its contents); the asked side only that it went.
	const settled = settleRequest({
		state: withoutRequest(state, request.id),
		from: request.from,
		to: request.to,
		id: request.id,
		at: stamped.at,
		card: input.path
			? { status: 'answered', answer: input.path }
			: { status: 'failed', answer: reason },
		run: input.path ? { status: 'answered' } : { status: 'failed', answer: reason },
	});

	return deliverSend({
		state: settled,
		ref: request.from,
		text,
		note: buildPeerNote(toLabel),
		isSpoken: false,
		stamped,
		// Its ref stays the asked session's, for the rule that a session never tells back the one
		// whose message started its turn.
		from: { ref: request.to, label: SECRET_SENDER },
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
