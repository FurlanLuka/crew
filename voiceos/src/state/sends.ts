// What Voice OS says around the developer's words once they went somewhere: "Sent to X" when that is
// not the session on screen, and "Switch there?" so they can follow. Words reach another session only
// when the developer named it (tools/send-guard.ts): nothing here guesses where they were meant to go.
import {
	isSwitchOfferFresh,
	type Input,
	type Stamped,
	type State,
	type SwitchOfferKind,
} from '../shared/protocol.js';
import { isSetupRef } from '../shared/machine-ref.js';
import type { Effect, ReducerResult } from './reducer.js';
import { readScreenRef, sayAck, sayRef } from './helpers.js';
import { isReachable, readMachineName } from '../shared/machines.js';

// "Personal's setup", not "setup on Personal", even inside Personal: a bare "setup" is this Mac's.
const sayOffered = (state: State, ref: string): string => {
	const machine = isSetupRef(ref) ? readMachineName(state, ref) : null;

	return machine ? `${machine}'s setup` : sayRef(state, ref);
};

const describeOffer = (state: State, ref: string, kind: SwitchOfferKind): string => {
	switch (kind) {
		case 'activate':
			return `${sayOffered(state, ref)} isn't active. Activate it?`;
		case 'deactivate':
			return `${sayOffered(state, ref)} is working. Deactivate anyway?`;
		case 'switch':
			return `Switch to ${sayRef(state, ref)}?`;
	}
};

// "Switch to checkout?": asked aloud once, answered with a yes or let go.
const offerSwitch = (
	state: State,
	input: Extract<Input, { type: 'offer_switch' }>,
	at: number,
): ReducerResult => {
	const kind = input.kind ?? 'switch';

	return {
		state: {
			...state,
			switchOffer: {
				ref: input.ref,
				at,
				...(input.kind ? { kind: input.kind } : {}),
				...(input.words ? { words: input.words } : {}),
				...(input.thenSwitch ? { thenSwitch: true as const } : {}),
			},
		},
		effects: [
			kind === 'switch'
				? {
						type: 'speak',
						text: describeOffer(state, input.ref, kind),
						source: 'kernel',
						ref: input.ref,
						isAsking: true,
						priority: 'high',
					}
				: // A reply to what the developer just asked, said though the session may be inactive.
					sayAck(describeOffer(state, input.ref, kind), { isAsking: true, ref: input.ref }),
		],
	};
};

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
			// Activate and deactivate answer what the developer just asked: they replace an older offer.
			const isAnswer = input.kind === 'activate' || input.kind === 'deactivate';

			if (
				!state.sessions[input.ref] ||
				(!isAnswer && isSwitchOfferFresh(state.switchOffer, stamped.at))
			) {
				return result;
			}

			const offered = offerSwitch(state, input, stamped.at);

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
