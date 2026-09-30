import type { Store } from '../state/store.js';
import type { ToolCall } from '../tools/definitions.js';
import {
	GRID,
	isSwitchOfferFresh,
	type ListenMode,
	type State,
	type VoiceEntry,
} from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { decideDelivery } from '../state/delivery.js';
import type { HandsFreeResult } from '../tools/hands-free.js';
import type { OpenUrl } from '../tools/docs.js';
import type { KernelHandleParams } from './kernel.js';
import { readActiveRef, resolveTypedTarget, type UtteranceSource } from './refs.js';
import { readTargetAnswer, settleTarget } from './target.js';
import { readSessionLabel } from '../shared/machines.js';
import type { Judge } from '../judge/judge.js';
import { isShortEnoughToAnswer } from '../tools/send.js';

const log = createLogger('router');

export interface KernelTurn {
	reply: string;
	did: string[];
	calls: Pick<ToolCall, 'name'>[];
}

type KernelHandlerOptions = Required<KernelHandleParams>;

export type KernelHandler = (text: string, options: KernelHandlerOptions) => Promise<KernelTurn>;

export interface RouterOptions {
	store: Store;
	kernel: KernelHandler | null;
	// Reads the answer to "For checkout?" in any language.
	judge: Judge;
	now?: () => number;
}

export interface UtteranceOrigin {
	// Switches how the tab the words came from listens.
	setListenMode?: (mode: ListenMode) => HandsFreeResult;
	// Opens a doc in the tab the words came from; false when there is none.
	openUrl?: OpenUrl;
	// When the developer began saying them; typed words are "said" when routed.
	heardFrom?: number;
	// A dictation with nowhere to go goes back into the input of the tab it came from.
	keepDictation?: (text: string, reason: string) => void;
}

// Read ahead of the words by that Claude (worker.send): it knows what it is reading.
export const DICTATION_NOTE =
	'(Voice OS note — dictated by voice: a brain dump, as heard. Speech to text may have misheard some words.)';

interface AskKernelParams {
	kernel: KernelHandler | null;
	text: string;
	screen: string | null;
	isSpoken: boolean;
	saidAt: number;
	heardFrom: number;
	setListenMode: (mode: ListenMode) => HandsFreeResult;
	openUrl: OpenUrl;
}

// Why a dictation cannot go to the session on screen; null when it can.
export const decideDictationRefusal = (state: State, screen: string | null): string | null => {
	if (!screen || !state.sessions[screen]) {
		return 'no session on screen';
	}

	return state.asks.some((ask) => ask.ref === screen) ? `${screen} waits on an answer` : null;
};

const NO_TAB = (): HandsFreeResult => 'no_tab';
const NO_TAB_TO_OPEN: OpenUrl = () => false;

const NO_KERNEL_MESSAGE =
	'Voice needs the Anthropic key — see the banner. Typing into a session still works.';

export class UtteranceRouter {
	private chain: Promise<void> = Promise.resolve();
	private now: () => number;

	constructor(private options: RouterOptions) {
		this.now = options.now ?? Date.now;
	}

	handle(
		text: string,
		source: UtteranceSource = 'voice',
		origin: UtteranceOrigin = {},
	): Promise<void> {
		// One utterance at a time, so two can never interleave their effects.
		this.chain = this.chain
			.then(() => this.run(text, source, origin))
			.catch((error: unknown) => log.error('utterance failed', { error: String(error) }));

		return this.chain;
	}

	private async run(text: string, source: UtteranceSource, origin: UtteranceOrigin): Promise<void> {
		const { store, kernel } = this.options;
		const trimmedText = text.trim();

		if (!trimmedText) {
			return;
		}

		// "For checkout?" waits on these words: a yes or no settles it, anything else keeps the held
		// words on the screen and is routed as usual. Only spoken words answer a spoken question (text
		// typed into a session's box is for that session), and only words said after it was asked.
		const { targetAsk } = store.state;
		const heardFrom = origin.heardFrom ?? this.now();

		if (targetAsk && source === 'voice' && heardFrom >= targetAsk.at) {
			const answer = await readTargetAnswer(
				this.options.judge,
				trimmedText,
				readSessionLabel(store.state, targetAsk.ref),
			);

			// More than a short answer is new words too, whatever it answered: never swallowed.
			const isOnlyAnswer = answer !== 'other' && isShortEnoughToAnswer(trimmedText);

			settleTarget(store, answer === 'yes');
			log.info('target answered', { answer, isOnlyAnswer });

			if (isOnlyAnswer) {
				return;
			}
		}

		// Captured before anything runs: a switch_view during the turn does not move it.
		const screen = readActiveRef(store.state);
		const saidAt = this.now();

		if (source === 'dictated') {
			this.sendDictation(trimmedText, screen, saidAt, origin);

			return;
		}

		// Text typed into a session's own box is typing to that Claude, not a kernel turn.
		const typedTarget = source === 'typed' ? resolveTypedTarget(store.state, trimmedText) : null;

		if (typedTarget) {
			// Typing is writing to that Claude: it goes aside only when the developer says "by the way".
			const status = store.state.sessions[typedTarget]?.status ?? 'stopped';
			const isAside = decideDelivery({ status, utterance: trimmedText }) === 'aside';

			log.info('route', { source, to: typedTarget, aside: isAside, text: trimmedText });
			store.dispatch({
				type: 'send',
				ref: typedTarget,
				text: trimmedText,
				...(isAside ? { aside: true } : {}),
			});

			return;
		}

		log.info('route', { source, to: 'kernel', screen, text: trimmedText });
		// "Switch to checkout?" is answered by these words or let go: a yes switches in this turn. Words
		// said before it was asked leave it to its own lapse.
		const offerAt = isSwitchOfferFresh(store.state.switchOffer, origin.heardFrom ?? this.now())
			? store.state.switchOffer.at
			: null;

		const entry = await this.askKernel({
			kernel,
			text: trimmedText,
			screen,
			isSpoken: source === 'voice',
			saidAt,
			heardFrom: origin.heardFrom ?? saidAt,
			setListenMode: origin.setListenMode ?? NO_TAB,
			openUrl: origin.openUrl ?? NO_TAB_TO_OPEN,
		});
		store.dispatch({ type: 'voice_logged', screen: screen ?? GRID, entry });

		if (offerAt !== null) {
			store.dispatch({ type: 'switch_offer_closed', at: offerAt });
		}
	}

	private sendDictation(
		text: string,
		screen: string | null,
		saidAt: number,
		origin: UtteranceOrigin,
	): void {
		const { store } = this.options;
		const reason = decideDictationRefusal(store.state, screen);

		// Never through the kernel: a long dump would be read for commands, and could answer a permission.
		if (reason || !screen) {
			log.info('dictation kept in the input', { reason, chars: text.length });
			origin.keepDictation?.(text, reason ?? 'no session on screen');
			store.dispatch({
				type: 'spoken',
				text: 'Dictation not sent — it is in the text box.',
				source: 'alert',
			});

			return;
		}

		const status = store.state.sessions[screen]?.status ?? 'stopped';
		const isAside = decideDelivery({ status, utterance: text }) === 'aside';

		log.info('route', { source: 'dictated', to: screen, aside: isAside, chars: text.length });
		store.dispatch({
			type: 'send',
			ref: screen,
			text,
			note: DICTATION_NOTE,
			...(isAside ? { aside: true } : {}),
		});
		store.dispatch({
			type: 'voice_logged',
			screen,
			entry: { utterance: text, did: [`dictated to ${screen}`], reply: '', at: saidAt },
		});
	}

	private async askKernel({
		kernel,
		text,
		screen,
		isSpoken,
		saidAt,
		heardFrom,
		setListenMode,
		openUrl,
	}: AskKernelParams): Promise<VoiceEntry> {
		const { store } = this.options;

		if (!kernel) {
			store.dispatch({ type: 'spoken', text: NO_KERNEL_MESSAGE, source: 'kernel' });

			return { utterance: text, did: [], reply: NO_KERNEL_MESSAGE, at: saidAt };
		}

		try {
			const turn = await kernel(text, {
				forwardTo: screen,
				screen,
				isSpoken,
				heardFrom,
				setListenMode,
				openUrl,
			});
			const isIgnored =
				!turn.reply &&
				turn.calls.every((call) => call.name === 'ignore_words') &&
				turn.calls.length > 0;

			return {
				utterance: text,
				did: turn.did,
				reply: turn.reply,
				at: saidAt,
				...(isIgnored ? { isIgnored: true as const } : {}),
			};
		} catch (error) {
			log.error('kernel failed', { error: String(error) });
			store.dispatch({
				type: 'spoken',
				text: 'Voice OS could not handle that just now.',
				source: 'alert',
			});

			return { utterance: text, did: [], reply: '', at: saidAt, isFailed: true };
		}
	}
}
