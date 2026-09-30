import {
	FOLLOW_UP_MS,
	type QueuedMessage,
	type Session,
	type SessionStatus,
	type Stamped,
	type State,
} from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import {
	pointLastSpokenAt,
	sendNow,
	startWorker,
	updateSession,
	withoutEffects,
} from './helpers.js';
import { composeAckText, type SendAck, type SendTiming } from '../shared/ack.js';
import { openRedirect } from './redirect.js';
import { clearHeldLine } from './held-lines.js';

export const joinNotes = (
	carried: string | undefined,
	added: string | undefined,
): string | undefined => {
	// Words merged into one message keep what each carried; the same note twice is read once.
	if (!carried || !added || carried.includes(added)) {
		return carried || added;
	}

	return `${carried}\n\n${added}`;
};

export const hasFollowUpWaiting = (session: Session): boolean => {
	// The one signal that the running reply is being cut: the developer's follow-up waits at the head.
	return session.queue[0]?.isFollowUp === true;
};

const isFollowUp = (session: Session, at: number): boolean =>
	session.status === 'running' &&
	session.voiceTurnAt !== null &&
	at - session.voiceTurnAt < FOLLOW_UP_MS;

interface AckOutcome {
	effects: Effect[];
	isOwed: boolean;
}

export const NO_ACK: AckOutcome = { effects: [], isOwed: false };

interface DecideAckParams {
	ref: string;
	ack: SendAck | undefined;
	timing: SendTiming;
}

export const decideAck = ({ ref, ack, timing }: DecideAckParams): AckOutcome => {
	// Said from the branch the words actually took, so "after its current work" is always true.
	// An instruction's turn must end with a spoken report.
	if (!ack) {
		return NO_ACK;
	}

	const text = composeAckText(ack, timing);

	return {
		effects: text
			? [
					{
						type: 'speak',
						text,
						source: 'kernel',
						isReply: true,
						ref,
						isNamed: true,
						priority: 'high',
						isAck: true,
					},
				]
			: [],
		isOwed: ack.kind !== 'question',
	};
};

interface QueueFollowUpParams {
	state: State;
	ref: string;
	text: string;
	note: string | undefined;
	stamped: Stamped;
	isOwed: boolean;
}

const queueFollowUp = ({
	state,
	ref,
	text,
	note,
	stamped,
	isOwed,
}: QueueFollowUpParams): ReducerResult => {
	// Only the first of a burst interrupts; later words join it, so Claude reads the request once.
	const session = state.sessions[ref];
	const head = session?.queue[0];

	if (session && head && hasFollowUpWaiting(session)) {
		const mergedHead = {
			...head,
			text: `${head.text} ${text}`,
			...(head.note || note ? { note: joinNotes(head.note, note) } : {}),
			...(head.reportOwed || isOwed ? { reportOwed: true as const } : {}),
		};

		return withoutEffects(
			updateSession(state, ref, (current) => ({
				...current,
				queue: [mergedHead, ...current.queue.slice(1)],
			})),
		);
	}

	// Words spoken while the session was starting begin this same request: they go first, in order.
	const queue = session?.queue ?? [];
	const firstTypedIndex = queue.findIndex((message) => !message.isSpoken);
	const spokenEarlier = firstTypedIndex === -1 ? queue : queue.slice(0, firstTypedIndex);
	const firstSpoken = spokenEarlier[0];
	const carriedNote = [...spokenEarlier.map((message) => message.note), note].reduce(
		joinNotes,
		undefined,
	);
	// The cut-off turn is never narrated, so what it owed is reported with the follow-up.
	const isReportOwed =
		session?.reportOwed || spokenEarlier.some((message) => message.reportOwed) || isOwed;
	const followUpMessage: QueuedMessage = {
		id: firstSpoken?.id ?? stamped.id,
		text: [...spokenEarlier.map((message) => message.text), text].join(' '),
		at: firstSpoken?.at ?? stamped.at,
		isFollowUp: true,
		...(carriedNote ? { note: carriedNote } : {}),
		...(isReportOwed ? { reportOwed: true as const } : {}),
	};

	return {
		state: updateSession(state, ref, (current) => ({
			...current,
			needsUser: null,
			reportOwed: false,
			queue: [followUpMessage, ...current.queue.slice(spokenEarlier.length)],
		})),
		effects: [{ type: 'worker_interrupt', ref, reason: 'follow-up' }],
	};
};

export interface DeliverSendParams {
	state: State;
	ref: string;
	text: string;
	note?: string;
	isSpoken: boolean;
	stamped: Stamped;
	// A stopped session is started for it; false only queues it (a question set aside earlier).
	shouldStart?: boolean;
	ack?: SendAck;
	// Said to go right now: a running turn is replaced instead of queued behind.
	isNow?: boolean;
}

const withEffects = (result: ReducerResult, effects: Effect[]): ReducerResult => ({
	state: result.state,
	effects: [...effects, ...result.effects],
});

export const deliverSend = (params: DeliverSendParams): ReducerResult => {
	// The developer moved on: a line held from before these words would answer something older.
	const delivered = deliverWords({ ...params, state: clearHeldLine(params.state, params.ref) });

	// Whatever it still had to say predates these words: said now, it would answer something older.
	return params.isSpoken && params.state.sessions[params.ref]
		? withEffects(delivered, [{ type: 'drop_speech', ref: params.ref, before: params.stamped.at }])
		: delivered;
};

const deliverWords = ({
	state,
	ref,
	text,
	note,
	isSpoken,
	stamped,
	shouldStart = true,
	ack,
	isNow = false,
}: DeliverSendParams): ReducerResult => {
	// Words that reach the session itself: sent now, cut into the running reply, or queued behind it.
	const session = state.sessions[ref];

	if (!session) {
		return withoutEffects(state);
	}

	if (session.status === 'idle') {
		const { effects, isOwed } = decideAck({ ref, ack, timing: 'now' });

		return withEffects(
			sendNow({
				state,
				ref,
				text,
				note,
				isSpoken,
				itemId: stamped.id,
				at: stamped.at,
				reportOwed: isOwed,
			}),
			effects,
		);
	}

	// A follow-up already waiting behind the interrupted reply takes the rest of what is said, whatever the time.
	const hasWaitingFollowUp = session.status === 'running' && hasFollowUpWaiting(session);

	if (isSpoken && (hasWaitingFollowUp || isFollowUp(session, stamped.at))) {
		const { effects, isOwed } = decideAck({ ref, ack, timing: 'now' });

		return withEffects(queueFollowUp({ state, ref, text, note, stamped, isOwed }), effects);
	}

	// The developer already said to go now: no switch question, the running turn is replaced.
	if (isNow && session.status === 'running') {
		const { effects, isOwed } = decideAck({ ref, ack, timing: 'now' });

		return withEffects(replaceRunning({ state, ref, text, note, stamped, isOwed }), effects);
	}

	// Changing what a working session is doing is the developer's call: they are asked first.
	if (ack?.kind === 'redirect' && session.status === 'running') {
		return openRedirect({ state, ref, text, note, stamped });
	}

	const isStarting = session.status === 'stopped' || session.status === 'starting';
	const { effects, isOwed } = decideAck({ ref, ack, timing: isStarting ? 'starting' : 'queued' });
	const queuedMessage: QueuedMessage = {
		id: stamped.id,
		text,
		at: stamped.at,
		...(note ? { note } : {}),
		...(isSpoken && isStarting ? { isSpoken: true as const } : {}),
		...(isOwed ? { reportOwed: true as const } : {}),
	};
	const queued = updateSession(state, ref, (current) => ({
		...current,
		needsUser: null,
		queue: [...current.queue, queuedMessage],
	}));

	return withEffects(
		session.status === 'stopped' && shouldStart ? startWorker(queued, ref) : withoutEffects(queued),
		effects,
	);
};

interface ReplaceRunningParams {
	state: State;
	ref: string;
	text: string;
	note: string | undefined;
	stamped: Stamped;
	isOwed: boolean;
}

export const replaceRunning = ({
	state,
	ref,
	text,
	note,
	stamped,
	isOwed,
}: ReplaceRunningParams): ReducerResult => {
	// The running turn's work is replaced, not added to: it is cut like a follow-up cuts it (never
	// narrated), and these words go first; whatever else waits keeps its place behind them.
	const session = state.sessions[ref];

	if (!session) {
		return withoutEffects(state);
	}

	const message: QueuedMessage = {
		id: stamped.id,
		text,
		at: stamped.at,
		isFollowUp: true,
		...(note ? { note } : {}),
		...(session.reportOwed || isOwed ? { reportOwed: true as const } : {}),
	};

	return {
		state: updateSession(state, ref, (current) => ({
			...current,
			needsUser: null,
			reportOwed: false,
			queue: [message, ...current.queue],
		})),
		effects: [{ type: 'worker_interrupt', ref, reason: 'follow-up' }],
	};
};

const ASIDE_PATTERN = /\b(?:by the way|btw)\b/i;
const QUEUE_PATTERN = /\bqueue it\b/i;
// "ask it right now: …", "tell it directly to …", "send this to it immediately", "send it now: …".
// Only the unambiguous words may stand a few words off: a bare "now" further along is content
// ("tell them the build now passes"), and so is anything after "that" or a question word ("tell it
// that right now the tests are red", "ask it why tests fail right now").
const NOW_PATTERN =
	/\b(?:send|ask|tell)\s+(?:it|them|claude|this|that)\b(?:(?:\s+(?!(?:that|why|what|how|whether|if|when|where|which|who)\b)\w+){0,3}?\s+(?:right now|directly|immediately)|\s+now)\b/i;
// The phrase alone ("send it now") names no words: that is the queued message, not new content.
const MIN_NOW_CONTENT_WORDS = 2;

const isSendNow = (utterance: string): boolean => {
	const phrase = NOW_PATTERN.exec(utterance);

	if (!phrase) {
		return false;
	}

	const content = utterance.replace(phrase[0], ' ').match(/[\p{L}\p{N}']+/gu) ?? [];

	return content.length >= MIN_NOW_CONTENT_WORDS;
};

// What the judge heard them want; unclear or default is the kernel's reading of the words.
const decideWanted = (
	status: SessionStatus,
	kind: DecideDeliveryParams['kind'],
	wanted: NonNullable<DecideDeliveryParams['wanted']>,
): Delivery => {
	switch (wanted) {
		case 'aside':
			return 'aside';
		case 'queue':
			return 'send';
		case 'now':
			// A blocked session waits on the developer: their words already go at once.
			return status === 'running' ? 'now' : 'send';
		default:
			return kind === 'question' ? 'aside' : 'send';
	}
};

export interface DecideDeliveryParams {
	status: SessionStatus;
	// The kernel's reading of the words; absent for typed text, which goes aside only when asked to.
	kind?: 'question' | 'instruction' | 'redirect';
	// What the developer actually said: typed words go aside on "by the way", queue on "queue it".
	utterance: string;
	// Spoken words, judged in their own language (the judge's delivery answer): no keywords read.
	wanted?: 'aside' | 'queue' | 'now' | 'default' | 'unclear';
}

export type Delivery = 'send' | 'aside' | 'now';

export const decideDelivery = ({
	status,
	kind,
	utterance,
	wanted,
}: DecideDeliveryParams): Delivery => {
	// A working session, or one waiting on a plan or permission, answers a question aside: the work
	// is not disturbed and the ask keeps waiting. An idle one answers the question itself, at once.
	if (status !== 'running' && status !== 'blocked') {
		return 'send';
	}

	if (wanted !== undefined) {
		return decideWanted(status, kind, wanted);
	}

	if (ASIDE_PATTERN.test(utterance)) {
		return 'aside';
	}

	if (QUEUE_PATTERN.test(utterance)) {
		return 'send';
	}

	// Said to go right now: the running turn is replaced, not queued behind. A blocked session is
	// waiting on the developer, so its words already go at once.
	if (status === 'running' && isSendNow(utterance)) {
		return 'now';
	}

	return kind === 'question' ? 'aside' : 'send';
};

interface SendFirstParams {
	state: State;
	ref: string;
	message: QueuedMessage;
	stamped: Stamped;
}

const sendFirst = ({ state, ref, message, stamped }: SendFirstParams): ReducerResult => {
	// Words wanted now replace the running work, as a switch the developer confirmed.
	const session = state.sessions[ref];

	if (!session) {
		return withoutEffects(state);
	}

	if (session.status === 'running') {
		return replaceRunning({
			state,
			ref,
			text: message.text,
			note: message.note,
			stamped: { ...stamped, id: message.id },
			isOwed: true,
		});
	}

	const first = updateSession(state, ref, (current) => ({
		...current,
		queue: [message, ...current.queue],
	}));

	// "Now" on a stopped session starts it, as any words sent to it would.
	return session.status === 'stopped' ? startWorker(first, ref) : withoutEffects(first);
};

interface PromoteQueuedParams {
	state: State;
	ref: string;
	queuedId: string;
	stamped: Stamped;
}

export const promoteQueued = ({
	state,
	ref,
	queuedId,
	stamped,
}: PromoteQueuedParams): ReducerResult => {
	const message = state.sessions[ref]?.queue.find((queued) => queued.id === queuedId);

	if (!message) {
		return withoutEffects(state);
	}

	const rest = updateSession(state, ref, (current) => ({
		...current,
		queue: current.queue.filter((queued) => queued.id !== queuedId),
	}));

	return sendFirst({ state: rest, ref, message, stamped });
};

export const isDevelopersMessage = (message: QueuedMessage): boolean => !message.isRetry;

interface PromoteAllQueuedParams {
	state: State;
	ref: string;
	stamped: Stamped;
}

export const promoteAllQueued = ({
	state,
	ref,
	stamped,
}: PromoteAllQueuedParams): ReducerResult => {
	// "Send both now": the developer's queued messages become one, in the order they were said, so
	// Claude reads the request once. A retry Voice OS queued keeps its place: it was never theirs.
	const waiting = state.sessions[ref]?.queue.filter(isDevelopersMessage) ?? [];
	const [first] = waiting;

	if (!first) {
		return withoutEffects(state);
	}

	const note = waiting.map((message) => message.note).reduce(joinNotes, undefined);
	const merged: QueuedMessage = {
		id: first.id,
		text: waiting.map((message) => message.text).join('\n\n'),
		at: first.at,
		...(note ? { note } : {}),
		...(waiting.some((message) => message.reportOwed) ? { reportOwed: true as const } : {}),
	};
	const rest = updateSession(state, ref, (current) => ({
		...current,
		queue: current.queue.filter((message) => !isDevelopersMessage(message)),
	}));
	// "Take that back" after the merge takes back the merged words, whichever of them it pointed at.
	const pointed = waiting.reduce(
		(current, message) => pointLastSpokenAt(current, message.id, merged.id),
		rest,
	);

	return sendFirst({ state: pointed, ref, message: merged, stamped });
};
