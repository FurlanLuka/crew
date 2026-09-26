import {
	FOLLOW_UP_MS,
	type QueuedMessage,
	type Session,
	type SessionStatus,
	type Stamped,
	type State,
} from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { sendNow, startWorker, updateSession, withoutEffects } from './helpers.js';

export const hasFollowUpWaiting = (session: Session): boolean => {
	// The one signal that the running reply is being cut: the developer's follow-up waits at the head.
	return session.queue[0]?.isFollowUp === true;
};

const isFollowUp = (session: Session, at: number): boolean =>
	session.status === 'running' &&
	session.voiceTurnAt !== null &&
	at - session.voiceTurnAt < FOLLOW_UP_MS;

interface QueueFollowUpParams {
	state: State;
	ref: string;
	text: string;
	note: string | undefined;
	stamped: Stamped;
}

const queueFollowUp = ({ state, ref, text, note, stamped }: QueueFollowUpParams): ReducerResult => {
	// Only the first of a burst interrupts; later words join it, so Claude reads the request once.
	const session = state.sessions[ref];
	const head = session?.queue[0];

	if (session && head && hasFollowUpWaiting(session)) {
		const mergedHead = {
			...head,
			text: `${head.text} ${text}`,
			...(note && !head.note ? { note } : {}),
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
	const carriedNote = spokenEarlier.find((message) => message.note)?.note ?? note;
	const followUpMessage: QueuedMessage = {
		id: firstSpoken?.id ?? stamped.id,
		text: [...spokenEarlier.map((message) => message.text), text].join(' '),
		at: firstSpoken?.at ?? stamped.at,
		isFollowUp: true,
		...(carriedNote ? { note: carriedNote } : {}),
	};

	return {
		state: updateSession(state, ref, (current) => ({
			...current,
			needsUser: null,
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
}

export const deliverSend = ({
	state,
	ref,
	text,
	note,
	isSpoken,
	stamped,
	shouldStart = true,
}: DeliverSendParams): ReducerResult => {
	// Words that reach the session itself: sent now, cut into the running reply, or queued behind it.
	const session = state.sessions[ref];

	if (!session) {
		return withoutEffects(state);
	}

	if (session.status === 'idle') {
		return sendNow({ state, ref, text, note, isSpoken, itemId: stamped.id, at: stamped.at });
	}

	// A follow-up already waiting behind the interrupted reply takes the rest of what is said, whatever the time.
	const hasWaitingFollowUp = session.status === 'running' && hasFollowUpWaiting(session);

	if (isSpoken && (hasWaitingFollowUp || isFollowUp(session, stamped.at))) {
		return queueFollowUp({ state, ref, text, note, stamped });
	}

	const isStarting = session.status === 'stopped' || session.status === 'starting';
	const queuedMessage: QueuedMessage = {
		id: stamped.id,
		text,
		at: stamped.at,
		...(note ? { note } : {}),
		...(isSpoken && isStarting ? { isSpoken: true as const } : {}),
	};
	const queued = updateSession(state, ref, (current) => ({
		...current,
		needsUser: null,
		queue: [...current.queue, queuedMessage],
	}));

	return session.status === 'stopped' && shouldStart
		? startWorker(queued, ref)
		: withoutEffects(queued);
};

const ASIDE_PATTERN = /\b(?:by the way|btw)\b/i;
const QUEUE_PATTERN = /\bqueue it\b/i;

export interface DecideDeliveryParams {
	status: SessionStatus;
	// The kernel's reading of the words; absent for typed text, which goes aside only when asked to.
	kind?: 'question' | 'instruction';
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
