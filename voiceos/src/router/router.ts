import type { Store } from '../state/store.js';
import type { ToolCall } from '../tools/definitions.js';
import { GRID, type VoiceEntry } from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { decideDelivery } from '../state/delivery.js';
import type { HandsFreeResult } from '../tools/hands-free.js';
import type { OpenUrl } from '../tools/docs.js';
import type { KernelHandleParams } from './kernel.js';
import { readActiveRef, resolveTypedTarget, type UtteranceSource } from './refs.js';

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
	now?: () => number;
}

export interface UtteranceOrigin {
	// Switches hands-free in the tab the words came from.
	setHandsFree?: (isOn: boolean) => HandsFreeResult;
	// Opens a doc in the tab the words came from; false when there is none.
	openUrl?: OpenUrl;
	// When the developer began saying them; typed words are "said" when routed.
	heardFrom?: number;
}

interface AskKernelParams {
	kernel: KernelHandler | null;
	text: string;
	screen: string | null;
	isSpoken: boolean;
	saidAt: number;
	heardFrom: number;
	setHandsFree: (isOn: boolean) => HandsFreeResult;
	openUrl: OpenUrl;
}

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

		// Captured before anything runs: a switch_view during the turn does not move it.
		const screen = readActiveRef(store.state);
		const saidAt = this.now();

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

		const entry = await this.askKernel({
			kernel,
			text: trimmedText,
			screen,
			isSpoken: source === 'voice',
			saidAt,
			heardFrom: origin.heardFrom ?? saidAt,
			setHandsFree: origin.setHandsFree ?? NO_TAB,
			openUrl: origin.openUrl ?? NO_TAB_TO_OPEN,
		});
		store.dispatch({ type: 'voice_logged', screen: screen ?? GRID, entry });
	}

	private async askKernel({
		kernel,
		text,
		screen,
		isSpoken,
		saidAt,
		heardFrom,
		setHandsFree,
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
				setHandsFree,
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
