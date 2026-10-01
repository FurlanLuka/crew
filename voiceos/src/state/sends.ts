// What Voice OS says around the developer's words once they went somewhere: "Sent to X" when that is
// not the session on screen, and "Switch there?" so they can follow. Words reach another session only
// when the developer named it (tools/send-guard.ts): nothing here guesses where they were meant to go.
import { isSwitchOfferFresh, type Input, type Stamped, type State } from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { sayAck, sayRef } from './helpers.js';
import { isReachable } from '../shared/machines.js';

// A permission, plan or question a session raised after `at`: then that, not "Switch to …?", is the
// newest thing asked, and a bare yes or no answers it.
export const hasQuestionSince = (state: State, at: number): boolean =>
	state.asks.some((ask) => ask.at > at) ||
	state.order.some((ref) => (state.sessions[ref]?.needsUser?.at ?? 0) > at);

const readScreenRef = (state: State): string | null =>
	state.view.kind === 'session' ? state.view.ref : null;

// "Switch to checkout?": asked aloud once, answered with a yes or let go.
const offerSwitch = (state: State, ref: string, at: number): ReducerResult => ({
	state: { ...state, switchOffer: { ref, at } },
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
});

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

interface IsSwitchWorthAskingParams {
	state: State;
	ref: string;
	at: number;
}

// Not to a machine out of reach (the words wait for it), not over its own open question, and not
// over an offer still being answered. Another session's question does not hold it back: a bare yes
// goes to whichever was asked last (answer.ts, isClearlyAnswerFor).
const isSwitchWorthAsking = ({ state, ref, at }: IsSwitchWorthAskingParams): boolean =>
	isReachable(state, ref) &&
	!state.asks.some((ask) => ask.ref === ref) &&
	!isSwitchOfferFresh(state.switchOffer, at);

// Runs after the input's own reducer: `before` is the state it started from.
export const followSends = (
	before: State,
	result: ReducerResult,
	stamped: Stamped,
): ReducerResult => {
	const input: Input = stamped.input;
	const { state } = result;

	switch (input.type) {
		case 'send': {
			const screenRef = readScreenRef(before);

			// The session on screen answers for itself; on Mission Control the kernel's own reply says
			// where the words went.
			if (!state.sessions[input.ref] || screenRef === null || input.ref === screenRef) {
				return result;
			}

			// Said to the session on screen, and the developer clicked away before the words went: they
			// left it. No "Sent to", no switch offer — its reply waits for the meanwhile line like any
			// other session's.
			if (input.isSpoken && input.saidOn === input.ref) {
				return result;
			}

			const isAcked = result.effects.some((effect) => effect.type === 'speak' && effect.isAck);
			const sentTo = sayRef(state, input.ref);
			const acked = isAcked ? result.effects : [...result.effects, sayAck(`Sent to ${sentTo}.`)];

			// Spoken words that went elsewhere: the developer may want to follow them there.
			if (!input.isSpoken || !isSwitchWorthAsking({ state, ref: input.ref, at: stamped.at })) {
				return { state, effects: acked };
			}

			return {
				state: { ...state, switchOffer: { ref: input.ref, at: stamped.at } },
				effects: withSwitchAsked({ effects: result.effects, ref: input.ref, sentTo }),
			};
		}

		case 'switch_view':
			return state.switchOffer ? { ...result, state: { ...state, switchOffer: null } } : result;

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

		default:
			return result;
	}
};
