import {
	COMMAND_TTL_MS,
	EXCHANGE_IDLE_MS,
	QUESTION_UNHEARD_MS,
	SWITCH_OFFER_MS,
	TARGET_ASK_MS,
} from '../shared/protocol.js';
import { settleTarget } from '../router/target.js';
import type { Effect } from '../state/reducer.js';
import type { Store } from '../state/store.js';
import type { KernelHandler, KernelTurn } from '../router/router.js';
import type { VoiceOut } from './voice-out.js';
import { createLogger } from '../log.js';
import type { Input, State } from '../shared/protocol.js';

const log = createLogger('exchange');

// Each change to who the developer talks with, with the input that made it: how often a guess was
// wrong is read from these and the debug notes.
const logConversation = (before: State, after: State, input: Input): void => {
	if (
		before.exchange?.ref !== after.exchange?.ref ||
		before.exchange?.reason !== after.exchange?.reason
	) {
		log.info('exchange', {
			from: before.exchange?.ref ?? null,
			to: after.exchange?.ref ?? null,
			reason: after.exchange?.reason ?? null,
			input: input.type,
		});
	}

	if (after.switchOffer && after.switchOffer !== before.switchOffer) {
		log.info('switch offered', { ref: after.switchOffer.ref });
	}

	if (before.targetAsk !== after.targetAsk) {
		log.info(after.targetAsk ? 'asked which session' : 'which session settled', {
			ref: after.targetAsk?.ref ?? before.targetAsk?.ref ?? null,
		});
	}

	if (input.type === 'meanwhile_added') {
		log.info('update waits', { ref: input.ref, kind: input.kind, waiting: after.meanwhile.length });
	}

	if (input.type === 'play_meanwhile' && before.meanwhile.length > 0) {
		log.info('meanwhile said', { count: before.meanwhile.length });
	}

	if (input.type === 'go_back') {
		log.info('go back', {
			to: after.view,
			// Entries passed over (stopped since, or gone) beside the one returned to.
			skipped: Math.max(0, before.viewHistory.length - after.viewHistory.length - 1),
		});
	}
};

type NarrateEffect = Extract<Effect, { type: 'narrate' }>;
type NarrateAsideEffect = Extract<Effect, { type: 'narrate_aside' }>;

export interface ConnectSpeechParams {
	store: Store;
	voiceOut: VoiceOut;
	narrateTurn: (effect: NarrateEffect) => Promise<void> | void;
	narrateAside: (effect: NarrateAsideEffect) => Promise<void> | void;
	// Tests run the clock themselves.
	setTimer?: (run: () => void, ms: number) => unknown;
}

// What the store asks to be said, dropped or narrated reaches the voice here: the app and the
// conversation tests share this wiring, so a test hears what the developer would.
export const connectSpeech = ({
	store,
	voiceOut,
	narrateTurn,
	narrateAside,
	setTimer = setTimeout,
}: ConnectSpeechParams): void => {
	// The reducer runs in the page too, so it cannot log: what the conversation did is logged here.
	let previous = store.state;
	store.subscribe((stamped, state) => {
		logConversation(previous, state, stamped.input);
		previous = state;
	});

	// A conversation lapses a minute after its last send or answer heard: each one re-arms the timer,
	// and a stale timer finds a newer lastAt and changes nothing.
	let armedAt: number | null = null;
	let offeredAt: string | null = null;
	let targetAskedAt: string | null = null;
	store.subscribe((_stamped, state) => {
		const { exchange, switchOffer, targetAsk } = state;

		// "For checkout?" unanswered: silence keeps the words on the screen. The wait starts once the
		// question was heard (or is given up on if it never plays).
		const targetKey = targetAsk ? `${targetAsk.at}:${targetAsk.heardAt ?? ''}` : null;

		if (targetAsk && targetKey !== targetAskedAt) {
			targetAskedAt = targetKey;
			const { at, heardAt } = targetAsk;
			setTimer(
				() => {
					// A timer armed before the question was heard gives way to the one armed after.
					if (store.state.targetAsk?.at === at && store.state.targetAsk.heardAt === heardAt) {
						settleTarget(store, false);
					}
				},
				targetAsk.heardAt === undefined ? QUESTION_UNHEARD_MS : TARGET_ASK_MS,
			);
		}

		if (exchange && exchange.lastAt !== armedAt) {
			armedAt = exchange.lastAt;
			const { ref, lastAt } = exchange;
			setTimer(() => store.dispatch({ type: 'exchange_expired', ref, lastAt }), EXCHANGE_IDLE_MS);
		}

		// "Switch to checkout?" is answered at once or let go, counted from when it was heard.
		const offerKey = switchOffer ? `${switchOffer.at}:${switchOffer.heardAt ?? ''}` : null;

		if (switchOffer && offerKey !== offeredAt) {
			offeredAt = offerKey;
			const { at } = switchOffer;
			setTimer(
				() => store.dispatch({ type: 'switch_offer_closed', at, isLapse: true }),
				switchOffer.heardAt === undefined ? QUESTION_UNHEARD_MS : SWITCH_OFFER_MS,
			);
		}
	});

	store.onEffect((effect) => {
		switch (effect.type) {
			case 'speak':
				voiceOut.say({
					text: effect.text,
					priority: effect.priority ?? (effect.source === 'alert' ? 'alert' : 'normal'),
					source: effect.source,
					isReply: effect.isReply,
					isAnswer: effect.isAnswer,
					waitsForGap: effect.waitsForGap,
					ref: effect.ref ?? null,
					isAsking: effect.isAsking,
					isUpdate: effect.isUpdate,
					refs: effect.refs,
					isNamed: effect.isNamed,
					isOwed: effect.isOwed,
					isAck: effect.isAck,
					isHoldable: effect.isHoldable,
					chime: effect.chime,
				});

				return;
			case 'drop_speech':
				voiceOut.dropQueuedAbout(effect.ref, effect.before);

				return;
			case 'narrate':
				return narrateTurn(effect);
			case 'narrate_aside':
				return narrateAside(effect);
			case 'expire_command':
				setTimer(
					() => store.dispatch({ type: 'command_expired', askId: effect.askId }),
					COMMAND_TTL_MS,
				);

				return;
		}
	});
};

// The kernel's own reply to the developer is said at once, as the answer to what they just said.
export const speakKernelReplies =
	(handle: KernelHandler, voiceOut: VoiceOut): KernelHandler =>
	async (text, options): Promise<KernelTurn> => {
		const turn = await handle(text, options);

		if (turn.reply) {
			voiceOut.say({ text: turn.reply, priority: 'high', source: 'kernel', isReply: true });
		}

		return turn;
	};
