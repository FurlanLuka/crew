import {
	COMMAND_TTL_MS,
	type Input,
	type PendingAsk,
	type Stamped,
	type State,
} from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { deliverSend, replaceRunning } from './delivery.js';
import {
	pointLastSpokenAt,
	pushNotice,
	readLabel,
	updateSession,
	withoutEffects,
} from './helpers.js';

export type RedirectAsk = Extract<PendingAsk, { kind: 'redirect' }>;

type RedirectInput = Extract<Input, { type: 'answer_redirect' }>;

const MAX_REQUEST_WORDS = 12;
const DANGLING_WORDS = new Set([
	'the',
	'a',
	'an',
	'and',
	'or',
	'of',
	'to',
	'in',
	'on',
	'for',
	'with',
	'then',
]);

export const findRedirectAsk = (state: State, ref: string): RedirectAsk | null => {
	const ask = state.asks.find((pending) => pending.ref === ref && pending.kind === 'redirect');

	return ask?.kind === 'redirect' ? ask : null;
};

const describeCurrentWork = (request: string | undefined): string => {
	// Cut where the first clause ends: a phrase broken mid-way reads badly aloud.
	const clause = request
		?.trim()
		.split(/[.;:!?]|,\s/)[0]
		?.trim();

	if (!clause) {
		return 'its current work';
	}

	const words = clause.split(/\s+/);

	if (words.length <= MAX_REQUEST_WORDS) {
		return clause;
	}

	// Cut short, it must not end on a word that promises more ("…rename all the").
	const kept = words.slice(0, MAX_REQUEST_WORDS);

	while (kept.length > 1 && DANGLING_WORDS.has(kept.at(-1)?.toLowerCase() ?? '')) {
		kept.pop();
	}

	return kept.join(' ');
};

export const describeRedirectAloud = (state: State, ref: string): string => {
	const request = state.sessions[ref]?.requests.at(-1)?.text;

	return `${readLabel(state, ref)} is still on ${describeCurrentWork(request)}. Stop it and switch? Say yes, or it goes after.`;
};

interface OpenRedirectParams {
	state: State;
	ref: string;
	text: string;
	note: string | undefined;
	stamped: Stamped;
}

export const openRedirect = ({
	state,
	ref,
	text,
	note,
	stamped,
}: OpenRedirectParams): ReducerResult => {
	// Stopping work the developer started is theirs to confirm; the question is the only thing said.
	const ask: RedirectAsk = {
		id: stamped.id,
		ref,
		at: stamped.at,
		kind: 'redirect',
		text,
		...(note ? { note } : {}),
		target: state.sessions[ref]?.currentSendId ?? null,
	};

	return {
		state: { ...state, asks: [...state.asks, ask] },
		effects: [
			{
				type: 'speak',
				text: describeRedirectAloud(state, ref),
				source: 'alert',
				ref,
				isAsking: true,
			},
			{ type: 'expire_command', askId: ask.id },
		],
	};
};

const removeAsk = (state: State, ask: RedirectAsk): State => ({
	...state,
	asks: state.asks.filter((pending) => pending.id !== ask.id),
});

interface ReleaseRedirectParams {
	state: State;
	ask: RedirectAsk;
	stamped: Stamped;
	// Said aloud when the developer did not choose where it went (a no, a lapse, a permission).
	isAnnounced: boolean;
	// A stopped session keeps it for its next start instead of being started for it.
	shouldStart?: boolean;
}

export const releaseRedirect = ({
	state,
	ask,
	stamped,
	isAnnounced,
	shouldStart = true,
}: ReleaseRedirectParams): ReducerResult => {
	// Not switching is never dropping: the instruction waits behind the current work.
	const delivered = deliverSend({
		state: pointLastSpokenAt(removeAsk(state, ask), ask.id, stamped.id),
		ref: ask.ref,
		text: ask.text,
		note: ask.note,
		isSpoken: false,
		stamped,
		shouldStart,
		ack: { kind: 'instruction' },
	});
	const effects: Effect[] = isAnnounced
		? delivered.effects
		: delivered.effects.filter((effect) => effect.type !== 'speak');

	return {
		state: pushNotice({
			state: delivered.state,
			ref: ask.ref,
			text: 'Not switched: it goes after the current work.',
			stamped,
			suffix: 'kept',
		}),
		effects,
	};
};

interface QueueHeldRedirectParams {
	state: State;
	ask: RedirectAsk;
	at: number;
	// Ahead of everything waiting: the work it asked to stop has just ended.
	isFirst: boolean;
}

export const queueHeldRedirect = ({ state, ask, at, isFirst }: QueueHeldRedirectParams): State => {
	// Its words become a message as they are, with no question left open about them.
	const message = {
		id: ask.id,
		text: ask.text,
		at,
		reportOwed: true as const,
		...(ask.note ? { note: ask.note } : {}),
	};

	return updateSession(removeAsk(state, ask), ask.ref, (session) => ({
		...session,
		queue: isFirst ? [message, ...session.queue] : [...session.queue, message],
	}));
};

export const isRedirectInput = (input: Input): input is RedirectInput =>
	input.type === 'answer_redirect';

interface SwitchToParams {
	state: State;
	ask: RedirectAsk;
	text: string;
	stamped: Stamped;
}

const switchTo = ({ state, ask, text, stamped }: SwitchToParams): ReducerResult => {
	const withoutAsk = removeAsk(state, ask);
	const session = withoutAsk.sessions[ask.ref];

	// The turn it was asked about is still the one running (or none was recorded): it is stopped and
	// this goes instead. A different turn running means that one ended: this simply goes.
	if (
		session?.status === 'running' &&
		(ask.target === null || session.currentSendId === ask.target)
	) {
		return replaceRunning({
			state: withoutAsk,
			ref: ask.ref,
			text,
			note: ask.note,
			stamped,
			isOwed: true,
		});
	}

	return deliverSend({
		state: withoutAsk,
		ref: ask.ref,
		text,
		note: ask.note,
		isSpoken: false,
		stamped,
		ack: { kind: 'instruction' },
	});
};

export const reduceRedirect = (
	state: State,
	input: RedirectInput | Extract<Input, { type: 'command_expired' }>,
	stamped: Stamped,
): ReducerResult => {
	const ask = state.asks.find((pending) => pending.id === input.askId);

	if (ask?.kind !== 'redirect') {
		return withoutEffects(state);
	}

	if (input.type === 'command_expired' || stamped.at - ask.at > COMMAND_TTL_MS) {
		return releaseRedirect({ state, ask, stamped, isAnnounced: true });
	}

	const added = input.message?.trim();

	if (input.isApproved) {
		return switchTo({ state, ask, text: added ? `${ask.text} ${added}` : ask.text, stamped });
	}

	if (!added) {
		return releaseRedirect({ state, ask, stamped, isAnnounced: true });
	}

	// "No, do X instead": X replaces the redirect, which is dropped.
	const dropped = pushNotice({
		state: removeAsk(state, ask),
		ref: ask.ref,
		text: 'Not switched; sent what was said instead.',
		stamped,
		suffix: 'dropped',
	});

	return deliverSend({
		state: dropped,
		ref: ask.ref,
		text: added,
		isSpoken: false,
		stamped,
		ack: { kind: 'instruction' },
	});
};
