import {
	FOLLOW_UP_MS,
	type QueuedMessage,
	type Session,
	type SessionStatus,
	type Stamped,
	type State,
} from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { sendNow, startWorker, updateSession, withoutEffects } from './helpers.js';
import { composeAckText, type SendAck, type SendTiming } from '../shared/ack.js';
import { openRedirect } from './redirect.js';

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
}

const withEffects = (result: ReducerResult, effects: Effect[]): ReducerResult => ({
	state: result.state,
	effects: [...effects, ...result.effects],
});

export const deliverSend = (params: DeliverSendParams): ReducerResult => {
	const delivered = deliverWords(params);

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

export interface DecideDeliveryParams {
	status: SessionStatus;
	// The kernel's reading of the words; absent for typed text, which goes aside only when asked to.
	kind?: 'question' | 'instruction' | 'redirect';
	// What the developer actually said: the kernel drops "by the way" from what it forwards.
	utterance: string;
}

export const decideDelivery = ({
	status,
	kind,
	utterance,
}: DecideDeliveryParams): 'send' | 'aside' => {
	// A working session, or one waiting on a plan or permission, answers a question aside: the work
	// is not disturbed and the ask keeps waiting. An idle one answers the question itself, at once.
	if (status !== 'running' && status !== 'blocked') {
		return 'send';
	}

	if (ASIDE_PATTERN.test(utterance)) {
		return 'aside';
	}

	if (QUEUE_PATTERN.test(utterance)) {
		return 'send';
	}

	return kind === 'question' ? 'aside' : 'send';
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
	// The developer wants queued words now: they replace the running work, as a switch they confirmed.
	const session = state.sessions[ref];
	const message = session?.queue.find((queued) => queued.id === queuedId);

	if (!session || !message) {
		return withoutEffects(state);
	}

	const rest = updateSession(state, ref, (current) => ({
		...current,
		queue: current.queue.filter((queued) => queued.id !== queuedId),
	}));

	if (session.status === 'running') {
		return replaceRunning({
			state: rest,
			ref,
			text: message.text,
			note: message.note,
			stamped: { ...stamped, id: message.id },
			isOwed: true,
		});
	}

	return withoutEffects(
		updateSession(rest, ref, (current) => ({ ...current, queue: [message, ...current.queue] })),
	);
};
