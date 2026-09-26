import {
	FOLLOW_UP_MS,
	type Input,
	type QueuedMessage,
	type Session,
	type Stamped,
	type State,
} from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { answerInWords } from './asks.js';
import { sendNow, startWorker, updateSession, withoutEffects } from './helpers.js';

type SendInput = Extract<Input, { type: 'send' }>;

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

export const reduceSend = (state: State, input: SendInput, stamped: Stamped): ReducerResult => {
	const session = state.sessions[input.ref];
	const text = input.text.trim();

	if (!session || !text) {
		return withoutEffects(state);
	}

	const focusedState = { ...state, focus: input.ref };
	const waitingAsk = state.asks.find((ask) => ask.ref === input.ref);

	if (waitingAsk) {
		return answerInWords({ state: focusedState, ask: waitingAsk, text, stamped });
	}

	const note = input.note?.trim() || undefined;
	const isSpoken = Boolean(input.isSpoken);

	if (session.status === 'idle') {
		return sendNow({
			state: focusedState,
			ref: input.ref,
			text,
			note,
			isSpoken,
			itemId: stamped.id,
			at: stamped.at,
		});
	}

	// A follow-up already waiting behind the interrupted reply takes the rest of what is said, whatever the time.
	const hasWaitingFollowUp = session.status === 'running' && hasFollowUpWaiting(session);

	if (isSpoken && (hasWaitingFollowUp || isFollowUp(session, stamped.at))) {
		return queueFollowUp({ state: focusedState, ref: input.ref, text, note, stamped });
	}

	const isStarting = session.status === 'stopped' || session.status === 'starting';
	const queuedMessage: QueuedMessage = {
		id: stamped.id,
		text,
		at: stamped.at,
		...(note ? { note } : {}),
		...(isSpoken && isStarting ? { isSpoken: true as const } : {}),
	};
	const queued = updateSession(focusedState, input.ref, (current) => ({
		...current,
		needsUser: null,
		queue: [...current.queue, queuedMessage],
	}));

	return session.status === 'stopped' ? startWorker(queued, input.ref) : withoutEffects(queued);
};
