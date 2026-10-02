import {
	COMMAND_TTL_MS,
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
import { isActive } from '../shared/active.js';
import type { Input, State } from '../shared/protocol.js';
import { startProgress, type WriteProgress } from './progress.js';

const log = createLogger('conversation');

// The questions Voice OS asks about where words go and the updates it says, with the input that
// made them: how often one was wrong is read from these and the debug notes.
const logConversation = (before: State, after: State, input: Input): void => {
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

// An inactive session says nothing: a late event from one just deactivated is dropped here. Voice OS's
// own reply about it ("…isn't active. Activate it?") is the developer's answer, and is said.
export const isSilenced = (state: State, effect: Effect): boolean => {
	switch (effect.type) {
		case 'speak':
			return (
				effect.ref !== undefined &&
				!(effect.source === 'kernel' && effect.isReply === true) &&
				!isActive(state, effect.ref)
			);
		case 'narrate':
		case 'narrate_aside':
			return !isActive(state, effect.ref);
		default:
			return false;
	}
};

type NarrateEffect = Extract<Effect, { type: 'narrate' }>;
type NarrateAsideEffect = Extract<Effect, { type: 'narrate_aside' }>;

const QUIET_RECHECK_MS = 500;
const QUIET_WAIT_MAX_MS = 30_000;

export interface ConnectSpeechParams {
	store: Store;
	voiceOut: VoiceOut;
	narrateTurn: (effect: NarrateEffect) => Promise<void> | void;
	narrateAside: (effect: NarrateAsideEffect) => Promise<void> | void;
	// Tests run the clock themselves.
	setTimer?: (run: () => void, ms: number) => unknown;
	// The router is still reading words the developer said: they may answer a question about to lapse.
	isRouting?: () => boolean;
	// Words a progress line for the session on screen; absent, it says none.
	writeProgress?: WriteProgress;
	now?: () => number;
}

// What the store asks to be said, dropped or narrated reaches the voice here: the app and the
// conversation tests share this wiring, so a test hears what the developer would.
export const connectSpeech = ({
	store,
	voiceOut,
	narrateTurn,
	narrateAside,
	setTimer = setTimeout,
	isRouting = () => false,
	writeProgress,
	now = Date.now,
}: ConnectSpeechParams): void => {
	if (writeProgress) {
		startProgress({ store, voiceOut, writeProgress, setTimer, isRouting, now });
	}

	// The reducer runs in the page too, so it cannot log: what the conversation did is logged here.
	let previous = store.state;
	store.subscribe((stamped, state) => {
		logConversation(previous, state, stamped.input);
		previous = state;
	});

	// A question that played in no tab was never asked: it lets go at once rather than holding the
	// developer's next yes or no, or their held words, for half a minute.
	store.subscribe((stamped, state) => {
		if (stamped.input.type !== 'spoken_ended' || !stamped.input.isUnplayed) {
			return;
		}

		const lineId = stamped.input.lineId;
		const line = state.spoken.find((spoken) => spoken.id === lineId);

		if (!line?.isAsking || !line.ref) {
			return;
		}

		const { switchOffer, targetAsk } = state;
		const ref = line.ref;

		queueMicrotask(() => {
			// Its own line, not an older question about the same session.
			if (
				switchOffer &&
				switchOffer.ref === ref &&
				switchOffer.heardAt === undefined &&
				line.at >= switchOffer.at
			) {
				store.dispatch({ type: 'switch_offer_closed', at: switchOffer.at });
			}

			if (
				targetAsk &&
				targetAsk.ref === ref &&
				targetAsk.heardAt === undefined &&
				line.at >= targetAsk.at &&
				store.state.targetAsk === targetAsk
			) {
				settleTarget(store, false);
			}
		});
	});

	// A question's wait ends in silence: while the developer is still speaking, or the router still
	// reads what they said, the words may be its answer, so it waits for them. Bounded, in case a press
	// never ends.
	const whenQuiet = (run: () => void, waited = 0): void => {
		if ((store.state.transcript === null && !isRouting()) || waited >= QUIET_WAIT_MAX_MS) {
			run();

			return;
		}

		setTimer(() => whenQuiet(run, waited + QUIET_RECHECK_MS), QUIET_RECHECK_MS);
	};

	let offeredAt: string | null = null;
	let targetAskedAt: string | null = null;
	store.subscribe((_stamped, state) => {
		const { switchOffer, targetAsk } = state;

		// "For checkout?" unanswered: silence keeps the words on the screen. The wait starts once the
		// question was heard (or is given up on if it never plays).
		const targetKey = targetAsk ? `${targetAsk.at}:${targetAsk.heardAt ?? ''}` : null;

		if (targetAsk && targetKey !== targetAskedAt) {
			targetAskedAt = targetKey;
			const { at, heardAt } = targetAsk;
			setTimer(
				() =>
					whenQuiet(() => {
						// A timer armed before the question was heard gives way to the one armed after.
						if (store.state.targetAsk?.at === at && store.state.targetAsk.heardAt === heardAt) {
							settleTarget(store, false);
						}
					}),
				targetAsk.heardAt === undefined ? QUESTION_UNHEARD_MS : TARGET_ASK_MS,
			);
		}

		// "Switch to checkout?" is answered at once or let go, counted from when it was heard.
		const offerKey = switchOffer ? `${switchOffer.at}:${switchOffer.heardAt ?? ''}` : null;

		if (switchOffer && offerKey !== offeredAt) {
			offeredAt = offerKey;
			const { at } = switchOffer;
			setTimer(
				() => whenQuiet(() => store.dispatch({ type: 'switch_offer_closed', at, isLapse: true })),
				switchOffer.heardAt === undefined ? QUESTION_UNHEARD_MS : SWITCH_OFFER_MS,
			);
		}
	});

	store.onEffect((effect) => {
		if (isSilenced(store.state, effect)) {
			log.info('inactive session: not said', { ref: 'ref' in effect ? effect.ref : null });

			return;
		}

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
					askId: effect.askId,
					askQuestion: effect.askQuestion,
					isUpdate: effect.isUpdate,
					refs: effect.refs,
					toldAsks: effect.toldAsks,
					isNamed: effect.isNamed,
					isOwed: effect.isOwed,
					isAck: effect.isAck,
					isHoldable: effect.isHoldable,
					chime: effect.chime,
					isFiller: effect.isFiller,
					facts: effect.facts,
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

const READ_TOOLS = new Set(['read_state', 'read_history']);

// The sessions a reply read back: heard to its end, it is their news as surely as their announcement
// (a reply to it from another screen offers the switch). The screen's own session and a read of every
// session name nothing.
export const listReadBackRefs = (calls: KernelTurn['calls'], screen: string | null): string[] => [
	...new Set(
		calls.flatMap((call) => {
			const ref = call.input?.ref;

			return READ_TOOLS.has(call.name) &&
				call.ok === true &&
				typeof ref === 'string' &&
				ref !== screen
				? [ref]
				: [];
		}),
	),
];

// The kernel's own reply to the developer is said at once, as the answer to what they just said.
export const speakKernelReplies =
	(handle: KernelHandler, voiceOut: VoiceOut): KernelHandler =>
	async (text, options): Promise<KernelTurn> => {
		const turn = await handle(text, options);

		if (!turn.reply) {
			return turn;
		}

		const refs = listReadBackRefs(turn.calls, options.screen);

		voiceOut.say({
			text: turn.reply,
			priority: 'high',
			source: 'kernel',
			isReply: true,
			...(refs.length > 0 ? { isUpdate: true, refs } : {}),
		});

		return turn;
	};
