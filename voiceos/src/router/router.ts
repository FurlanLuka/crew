import type { Store } from '../state/store.js';
import type { ToolCall } from '../tools/definitions.js';
import { GRID, type VoiceEntry } from '../shared/protocol.js';
import { createLogger } from '../log.js';
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

interface AskKernelParams {
	kernel: KernelHandler | null;
	text: string;
	screen: string | null;
	isSpoken: boolean;
	saidAt: number;
}

const NO_KERNEL_MESSAGE =
	'Voice needs the Anthropic key — see the banner. Typing into a session still works.';

export class UtteranceRouter {
	private chain: Promise<void> = Promise.resolve();
	private now: () => number;

	constructor(private options: RouterOptions) {
		this.now = options.now ?? Date.now;
	}

	handle(text: string, source: UtteranceSource = 'voice'): Promise<void> {
		// One utterance at a time, so two can never interleave their effects.
		this.chain = this.chain
			.then(() => this.run(text, source))
			.catch((error: unknown) => log.error('utterance failed', { error: String(error) }));

		return this.chain;
	}

	private async run(text: string, source: UtteranceSource): Promise<void> {
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
			log.info('route', { source, to: typedTarget, text: trimmedText });
			store.dispatch({ type: 'send', ref: typedTarget, text: trimmedText });

			return;
		}

		log.info('route', { source, to: 'kernel', screen, text: trimmedText });

		const entry = await this.askKernel({
			kernel,
			text: trimmedText,
			screen,
			isSpoken: source === 'voice',
			saidAt,
		});
		store.dispatch({ type: 'voice_logged', screen: screen ?? GRID, entry });
	}

	private async askKernel({
		kernel,
		text,
		screen,
		isSpoken,
		saidAt,
	}: AskKernelParams): Promise<VoiceEntry> {
		const { store } = this.options;

		if (!kernel) {
			store.dispatch({ type: 'spoken', text: NO_KERNEL_MESSAGE, source: 'kernel' });

			return { utterance: text, did: [], reply: NO_KERNEL_MESSAGE, at: saidAt };
		}

		try {
			const turn = await kernel(text, { forwardTo: screen, screen, isSpoken });
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
