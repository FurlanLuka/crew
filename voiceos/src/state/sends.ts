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
import { isActive } from '../shared/active.js';
import type { Effect, ReducerResult } from './reducer.js';
import { readScreenRef, sayAck, sayRef } from './helpers.js';
import { isReachable } from '../shared/machines.js';
import { withSwitchOffered } from '../shared/follow-up.js';
import { describeCarried } from './attachments.js';
import { isDevelopersMessage } from './delivery.js';

export const SEND_NOW_QUESTION = 'Send it now?';
// After a yes: the session answers the words itself once it has them.
export const SENT_NOW_LINE = 'Sending it now.';
const ALREADY_SENT_LINE = 'It already went.';

const describeOffer = (state: State, ref: string, kind: SwitchOfferKind): string => {
	switch (kind) {
		case 'activate':
			return `${sayRef(state, ref)} isn't active. Activate it?`;
		case 'deactivate':
			return `${sayRef(state, ref)} is working. Deactivate anyway?`;
		case 'skip_mode':
			return `Skip permissions for ${sayRef(state, ref)}?`;
		case 'switch':
			return `Switch to ${sayRef(state, ref)}?`;
		// Asked on the ack line itself (withSendNowAsked), never on its own.
		case 'send_now':
			return SEND_NOW_QUESTION;
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
	// " with 2 files", when the words took the session's attached files along.
	carried: string;
}

// The line that says where the words went asks the switch too ("Sent to crew. Switch there?",
// "Okay, after its current work. Switch there?"): one line, whichever ack it is.
// The facts say the switch is offered in the same step that appends the question, so a worded line
// never drops it or asks one that is not open.
// What a worded line is written from; with files the line is said as it is, since a worded one would
// drop them.
const sentFacts = (label: string, offersSwitch: boolean, carried: string) =>
	carried ? {} : { facts: { kind: 'sent' as const, label, offersSwitch } };

const withSwitchAsked = ({ effects, ref, sentTo, carried }: WithSwitchAskedParams): Effect[] => {
	const ackAt = effects.findLastIndex((effect) => effect.type === 'speak' && effect.isAck === true);

	if (ackAt < 0) {
		return [
			...effects,
			sayAck(`Sent to ${sentTo}${carried}. Switch there?`, {
				isAsking: true,
				ref,
				...sentFacts(sentTo, true, carried),
			}),
		];
	}

	return effects.map((effect, index) =>
		index === ackAt && effect.type === 'speak'
			? {
					...effect,
					text: `${effect.text.trim()} Switch there?`,
					isAsking: true,
					ref,
					...(effect.facts ? { facts: withSwitchOffered(effect.facts) } : {}),
				}
			: effect,
	);
};

interface SendNowParams {
	state: State;
	result: ReducerResult;
	ref: string;
	stamped: Stamped;
}

// Spoken words the session on screen queued behind its current work: the line that says so asks
// whether they should go now instead ("Okay, after its current work. Send it now?"). Only when they
// really wait there, and never over another open question of Voice OS's own; a yes sends everything
// of theirs that waits (router.ts).
const offerSendNow = ({ state, result, ref, stamped }: SendNowParams): ReducerResult | null => {
	const session = state.sessions[ref];
	const ackAt = result.effects.findIndex(
		(effect) => effect.type === 'speak' && effect.isAck === true && effect.facts?.kind === 'queued',
	);

	if (
		ackAt < 0 ||
		session?.status !== 'running' ||
		!session.queue.some((message) => message.id === stamped.id) ||
		// Its own question is asked again for the newer words (speaking let the old one go anyway).
		(isSwitchOfferFresh(state.switchOffer, stamped.at) &&
			!(state.switchOffer.kind === 'send_now' && state.switchOffer.ref === ref))
	) {
		return null;
	}

	return {
		state: {
			...state,
			switchOffer: { ref, at: stamped.at, kind: 'send_now', queuedId: stamped.id },
		},
		// The fixed line: a worded one may only ask to switch (voice-lines), so this one is said as it is.
		effects: result.effects.map((effect, index) => {
			if (index !== ackAt || effect.type !== 'speak') {
				return effect;
			}

			const { facts: _facts, ...line } = effect;

			return { ...line, text: `${effect.text.trim()} ${SEND_NOW_QUESTION}`, isAsking: true };
		}),
	};
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
	// An open offer of the same session is asked again: words sent there are the newer reason to go.
	(!isSwitchOfferFresh(state.switchOffer, at) || state.switchOffer.ref === ref);

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

			if (input.isSpoken && input.ref === screenRef) {
				return offerSendNow({ state, result, ref: input.ref, stamped }) ?? result;
			}

			// The session on screen answers for itself; off a session the kernel's own reply says
			// where the words went.
			// An inactive session only keeps the words: "…isn't active. Activate it?" says so.
			if (
				!state.sessions[input.ref] ||
				screenRef === null ||
				input.ref === screenRef ||
				!isActive(state, input.ref)
			) {
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
			// The session's waiting files went with these words: they are gone from it now.
			const carried = state.attachments[input.ref]
				? ''
				: describeCarried(before.attachments[input.ref]);
			const acked = isAcked
				? result.effects
				: [
						...result.effects,
						sayAck(`Sent to ${sentTo}${carried}.`, sentFacts(sentTo, false, carried)),
					];

			// Spoken words that went elsewhere: the developer may want to follow them there.
			if (!input.isSpoken || !isSwitchWorthAsking({ state, ref: input.ref, at: stamped.at })) {
				return { state, effects: acked };
			}

			return {
				state: { ...state, switchOffer: { ref: input.ref, at: stamped.at } },
				effects: withSwitchAsked({ effects: result.effects, ref: input.ref, sentTo, carried }),
			};
		}

		case 'switch_view':
			return state.switchOffer ? { ...result, state: { ...state, switchOffer: null } } : result;

		// "Send it now?" answered: by its yes or the card (answersOffer: said what happened, as only
		// Voice OS knows), or by the kernel's own "send it now" or the queue's ▲ (closed quietly: the
		// kernel says its own reply). Its turn may have ended while the question was out: then the
		// words already went.
		case 'promote_queued':
		case 'promote_all_queued': {
			const offer = state.switchOffer;

			// ▲ on an older message is not this question's answer; sending all of them is.
			if (
				offer?.kind !== 'send_now' ||
				offer.ref !== input.ref ||
				(input.type === 'promote_queued' && input.queuedId !== offer.queuedId)
			) {
				return result;
			}

			const closed = { ...state, switchOffer: null };

			if (!input.answersOffer) {
				return { state: closed, effects: result.effects };
			}

			const waiting = before.sessions[input.ref]?.queue.filter(isDevelopersMessage) ?? [];
			const wasWaiting =
				input.type === 'promote_all_queued'
					? waiting.length > 0
					: waiting.some((message) => message.id === input.queuedId);

			return {
				state: closed,
				effects: [
					...result.effects,
					sayAck(wasWaiting ? SENT_NOW_LINE : ALREADY_SENT_LINE, { ref: input.ref }),
				],
			};
		}

		// Its words left the queue another way (cancelled, taken back): the question is moot.
		case 'cancel_queued':
		case 'take_back': {
			const offer = state.switchOffer;
			const isGone =
				offer?.kind === 'send_now' &&
				offer.ref === input.ref &&
				!state.sessions[input.ref]?.queue.some((message) => message.id === offer.queuedId);

			return isGone ? { ...result, state: { ...state, switchOffer: null } } : result;
		}

		case 'offer_switch': {
			// Activate, deactivate and Skip answer what the developer just asked: they replace an older offer.
			const isAnswer =
				input.kind === 'activate' || input.kind === 'deactivate' || input.kind === 'skip_mode';

			// "Switch to X?" is about a session voice reaches; an inactive one is only ever offered activation.
			// A setup session is Set up's: voice never offers it.
			if (
				!state.sessions[input.ref] ||
				isSetupRef(input.ref) ||
				(!isAnswer && isSwitchOfferFresh(state.switchOffer, stamped.at)) ||
				(!isAnswer && !isActive(state, input.ref))
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
