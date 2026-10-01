// Who the developer is talking with. One field answers three questions: which session a follow-up
// goes to, whose answer plays first, and whether they are mid-conversation with the screen.
import {
	EXCHANGE_IDLE_MS,
	EXCHANGE_WORK_MS,
	isSwitchOfferFresh,
	type Exchange,
	type ExchangeReason,
	type Input,
	type Stamped,
	type State,
} from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { sayAck, sayRef } from './helpers.js';
import { forgetHeardUpdate } from './held-lines.js';
import { isReachable } from '../shared/machines.js';

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

	return { state: { ...state, exchange }, effects: [] };
};

const end = (state: State): State => {
	if (!state.exchange) {
		return state;
	}

	return { ...state, exchange: null };
};

// "Switch to checkout?": asked aloud once, answered with a yes or let go.
export const offerSwitch = (state: State, ref: string, at: number): ReducerResult => {
	return {
		state: {
			...state,
			switchOffer: { ref, at },
			exchange:
				state.exchange?.ref === ref
					? { ...state.exchange, hasOfferedSwitch: true }
					: state.exchange,
		},
		effects: [
			{
				type: 'speak',
				text: `Switch to ${sayRef(state, ref)}?`,
				source: 'kernel',
				ref,
				isAsking: true,
				priority: 'high',
			},
		],
	};
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

	// No switch is offered for a back-and-forth: the answers are said in full, follow-ups go there,
	// and "switch to it" works any time. The one offer is the one a reply to a heard update makes.
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

	return [sayAck(`Sent to ${sayRef(state, ref)}.`)];
};

// How long after hearing an update a reply to it still offers the switch.
const UPDATE_REPLY_MS = 10 * 60_000;

interface WithSwitchAskedParams {
	effects: Effect[];
	ref: string;
	sentTo: string;
}

// The line that says where the words went asks the switch too ("Sent to crew. Switch there?",
// "Okay, after its current work. Switch there?"): one line, whichever ack it is.
const withSwitchAsked = ({ effects, ref, sentTo }: WithSwitchAskedParams): Effect[] => {
	const ackAt = effects.findLastIndex((effect) => effect.type === 'speak' && effect.isAck === true);

	if (ackAt < 0) {
		return [...effects, sayAck(`Sent to ${sentTo}. Switch there?`, { isAsking: true, ref })];
	}

	return effects.map((effect, index) =>
		index === ackAt && effect.type === 'speak'
			? { ...effect, text: `${effect.text.trim()} Switch there?`, isAsking: true, ref }
			: effect,
	);
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

			// Said to the session on screen, and the developer clicked away before the words went: they
			// left it. No "Sent to", no conversation with it, no switch offer — its reply waits for the
			// meanwhile line like any other session's.
			if (input.isSpoken && input.saidOn === input.ref && readScreenRef(before) !== input.ref) {
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

			const screenRef = readScreenRef(before);
			const moved = talkTo({ state, ref: input.ref, at: stamped.at, screenRef });
			const heardAt = before.sessions[input.ref]?.updateHeardAt;
			// A reply to an update they heard ("crew needs you: …", the meanwhile line), sent from another
			// screen: without the page they would not know their words now go there. Once per update.
			const isReplyToHeard =
				screenRef !== null &&
				input.ref !== screenRef &&
				heardAt !== undefined &&
				stamped.at - heardAt <= UPDATE_REPLY_MS &&
				moved.state.exchange?.startedAt === stamped.at;
			const replied = forgetHeardUpdate(moved.state, input.ref);

			// Not to a machine out of reach (the words wait for it), and not over its own open question.
			// Another session's question does not hold it back: a bare yes goes to whichever was asked last
			// (answer.ts, isClearlyAnswerFor).
			if (
				isReplyToHeard &&
				isReachable(state, input.ref) &&
				!replied.asks.some((ask) => ask.ref === input.ref) &&
				!isSwitchOfferFresh(replied.switchOffer, stamped.at)
			) {
				const offered = offerSwitch(replied, input.ref, stamped.at);

				return {
					state: offered.state,
					effects: [
						...withSwitchAsked({
							effects: acked,
							ref: input.ref,
							sentTo: sayRef(state, input.ref),
						}),
						...moved.effects,
					],
				};
			}

			return { state: replied, effects: [...acked, ...moved.effects] };
		}

		case 'switch_view': {
			const settled = state.switchOffer ? { ...state, switchOffer: null } : state;
			const { exchange } = settled;

			// Switching to the session they talk with carries the conversation onto the screen.
			if (!exchange || (input.view.kind === 'session' && input.view.ref === exchange.ref)) {
				return { ...result, state: settled };
			}

			return { ...result, state: end(settled) };
		}

		case 'offer_switch': {
			if (!state.sessions[input.ref] || isSwitchOfferFresh(state.switchOffer, stamped.at)) {
				return result;
			}

			const offered = offerSwitch(state, input.ref, stamped.at);

			return { state: offered.state, effects: [...result.effects, ...offered.effects] };
		}

		// Answered, let go, or lapsed: a later "yes" is not for it. `at` names the offer it closes.
		case 'switch_offer_closed':
			return state.switchOffer?.at === input.at &&
				!(input.isLapse && isSwitchOfferFresh(state.switchOffer, stamped.at))
				? { ...result, state: { ...state, switchOffer: null } }
				: result;

		case 'spoken_ended': {
			if (input.isCut || input.isUnplayed) {
				return result;
			}

			const heard = hearAnswer(state, input.lineId, stamped.at);

			return { state: heard.state, effects: [...result.effects, ...heard.effects] };
		}

		case 'exchange_expired': {
			if (state.exchange?.ref !== input.ref || state.exchange.lastAt !== input.lastAt) {
				return result;
			}

			// Still working on what they asked in this conversation: it waits for the answer, the minute
			// counted again, but never past ten minutes since they last spoke to it. Waiting on the
			// developer (blocked) is not working on their question: it lapses as usual.
			const session = state.sessions[input.ref];
			const askedAt = session?.requests.at(-1)?.at ?? null;
			const isWorkingOnIt =
				session?.status === 'running' &&
				askedAt !== null &&
				askedAt >= state.exchange.startedAt &&
				stamped.at - askedAt < EXCHANGE_WORK_MS;

			return isWorkingOnIt
				? { ...result, state: { ...state, exchange: { ...state.exchange, lastAt: stamped.at } } }
				: { ...result, state: end(state) };
		}

		case 'clear_exchange':
			return { ...result, state: end(state) };

		default:
			return result;
	}
};

// Sessions that are gone take their conversation with them.
export const pruneExchange = (exchange: Exchange | null, isKept: (ref: string) => boolean) =>
	exchange && isKept(exchange.ref) ? exchange : null;
