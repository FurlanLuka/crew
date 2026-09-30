// Who the developer is talking with. One field answers three questions: which session a follow-up
// goes to, whose answer plays first, and whether they are mid-conversation with the screen.
import {
	EXCHANGE_IDLE_MS,
	type Exchange,
	type ExchangeReason,
	type Input,
	type Stamped,
	type State,
} from '../shared/protocol.js';
import { createLogger } from '../log.js';
import type { Effect, ReducerResult } from './reducer.js';
import { readLabel } from './helpers.js';
import { toSpokenName } from '../shared/spoken.js';

const log = createLogger('exchange');

export const readScreenRef = (state: State): string | null =>
	state.view.kind === 'session' ? state.view.ref : null;

export const isExchangeLive = (exchange: Exchange | null, now: number): exchange is Exchange =>
	exchange !== null && now - exchange.lastAt < EXCHANGE_IDLE_MS;

// A session the developer talks with that is not on screen.
export const readSubject = (state: State, now: number): string | null => {
	const { exchange } = state;

	return isExchangeLive(exchange, now) && exchange.ref !== readScreenRef(state)
		? exchange.ref
		: null;
};

// Talking with the session on screen: a notification from elsewhere does not pull them away.
export const isMidExchangeWithScreen = (state: State, now: number): boolean => {
	const { exchange } = state;

	return isExchangeLive(exchange, now) && exchange.ref === readScreenRef(state);
};

interface TalkToParams {
	state: State;
	ref: string;
	at: number;
	// The session on screen when the words were said.
	screenRef: string | null;
}

const decideReason = ({ state, ref, at, screenRef }: TalkToParams): ExchangeReason => {
	if (ref === screenRef) {
		return 'screen';
	}

	return isExchangeLive(state.exchange, at) && state.exchange.ref === ref ? 'follow_up' : 'named';
};

const talkTo = (params: TalkToParams): ReducerResult => {
	const { state, ref, at } = params;
	const isSame = isExchangeLive(state.exchange, at) && state.exchange.ref === ref;
	const reason = decideReason(params);
	const exchange: Exchange =
		isSame && state.exchange
			? { ...state.exchange, lastAt: at, reason }
			: {
					ref,
					startedAt: at,
					lastAt: at,
					answeredTurns: 0,
					countedTurnAt: null,
					hasOfferedSwitch: false,
					reason,
				};

	if (!isSame) {
		log.info('exchange', { ref, reason, from: state.exchange?.ref ?? null });
	}

	return { state: { ...state, exchange }, effects: [] };
};

const end = (state: State, why: string): State => {
	if (!state.exchange) {
		return state;
	}

	log.info('exchange ended', { ref: state.exchange.ref, why });

	return { ...state, exchange: null };
};

const hearAnswer = (state: State, lineId: string, at: number): ReducerResult => {
	const { exchange } = state;
	const line = state.spoken.find((spoken) => spoken.id === lineId);

	if (!isExchangeLive(exchange, at) || !line?.isAnswer || line.ref !== exchange.ref) {
		return { state, effects: [] };
	}

	// Several lines of one turn are one answer: the switch offer counts turns, not sentences.
	const turnAt = state.sessions[exchange.ref]?.requests.at(-1)?.at ?? null;
	// A session with no request on record (never asked through Voice OS): each answer is its own turn.
	const isNewTurn = turnAt === null || turnAt !== exchange.countedTurnAt;
	const heard: Exchange = {
		...exchange,
		lastAt: at,
		answeredTurns: exchange.answeredTurns + (isNewTurn ? 1 : 0),
		countedTurnAt: turnAt,
	};

	return { state: { ...state, exchange: heard }, effects: [] };
};

interface DescribeSentToParams {
	before: State;
	state: State;
	ref: string;
	at: number;
	effects: Effect[];
}

// Voice OS says where words went when the session that got them is not on screen, and when a
// conversation elsewhere just ended; the session on screen answers for itself.
const describeSentTo = ({ before, state, ref, at, effects }: DescribeSentToParams): Effect[] => {
	const screenRef = readScreenRef(before);
	const isAcked = effects.some((effect) => effect.type === 'speak' && effect.isAck);
	const wasElsewhere = readSubject(before, at) !== null;

	// On Mission Control nothing is on screen: the kernel's own reply says where words went.
	if (isAcked || screenRef === null || (ref === screenRef && !wasElsewhere)) {
		return [];
	}

	return [
		{
			type: 'speak',
			text: `Sent to ${toSpokenName(readLabel(state, ref))}.`,
			source: 'kernel',
			isReply: true,
			isAck: true,
			priority: 'high',
		},
	];
};

// Runs after the input's own reducer: `before` is the state it started from.
export const followExchange = (
	before: State,
	result: ReducerResult,
	stamped: Stamped,
): ReducerResult => {
	const input: Input = stamped.input;
	const { state } = result;

	switch (input.type) {
		case 'send': {
			if (!state.sessions[input.ref]) {
				return result;
			}

			const acked = [
				...result.effects,
				...describeSentTo({
					before,
					state,
					ref: input.ref,
					at: stamped.at,
					effects: result.effects,
				}),
			];

			if (!input.isSpoken) {
				return { state, effects: acked };
			}

			const moved = talkTo({
				state,
				ref: input.ref,
				at: stamped.at,
				screenRef: readScreenRef(before),
			});

			return { state: moved.state, effects: [...acked, ...moved.effects] };
		}

		case 'switch_view': {
			const { exchange } = state;

			// Switching to the session they talk with carries the conversation onto the screen.
			if (!exchange || (input.view.kind === 'session' && input.view.ref === exchange.ref)) {
				return result;
			}

			return { ...result, state: end(state, 'view switched') };
		}

		case 'spoken_ended': {
			if (input.isCut || input.isUnplayed) {
				return result;
			}

			const heard = hearAnswer(state, input.lineId, stamped.at);

			return { state: heard.state, effects: [...result.effects, ...heard.effects] };
		}

		case 'exchange_expired':
			return state.exchange?.ref === input.ref && state.exchange.lastAt === input.lastAt
				? { ...result, state: end(state, 'lapsed') }
				: result;

		case 'clear_exchange':
			return { ...result, state: end(state, 'cleared') };

		default:
			return result;
	}
};

// Sessions that are gone take their conversation with them.
export const pruneExchange = (exchange: Exchange | null, isKept: (ref: string) => boolean) =>
	exchange && isKept(exchange.ref) ? exchange : null;
