import {
	COMMAND_TTL_MS,
	EXCHANGE_IDLE_MS,
	SWITCH_OFFER_MS,
	TARGET_ASK_MS,
} from '../shared/protocol.js';
import { settleTarget } from '../router/target.js';
import type { Effect } from '../state/reducer.js';
import type { Store } from '../state/store.js';
import type { KernelHandler, KernelTurn } from '../router/router.js';
import type { VoiceOut } from './voice-out.js';

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
	// A conversation lapses a minute after its last send or answer heard: each one re-arms the timer,
	// and a stale timer finds a newer lastAt and changes nothing.
	let armedAt: number | null = null;
	let offeredAt: number | null = null;
	let targetAskedAt: number | null = null;
	store.subscribe((_stamped, state) => {
		const { exchange, switchOffer, targetAsk } = state;

		// "For checkout?" unanswered: silence keeps the words on the screen.
		if (targetAsk && targetAsk.at !== targetAskedAt) {
			targetAskedAt = targetAsk.at;
			const { at } = targetAsk;
			setTimer(() => {
				if (store.state.targetAsk?.at === at) {
					settleTarget(store, false);
				}
			}, TARGET_ASK_MS);
		}

		if (exchange && exchange.lastAt !== armedAt) {
			armedAt = exchange.lastAt;
			const { ref, lastAt } = exchange;
			setTimer(() => store.dispatch({ type: 'exchange_expired', ref, lastAt }), EXCHANGE_IDLE_MS);
		}

		// "Switch to checkout?" is answered at once or let go.
		if (switchOffer && switchOffer.at !== offeredAt) {
			offeredAt = switchOffer.at;
			const { at } = switchOffer;
			setTimer(() => store.dispatch({ type: 'switch_offer_closed', at }), SWITCH_OFFER_MS);
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
					ref: effect.ref ?? null,
					isAsking: effect.isAsking,
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
