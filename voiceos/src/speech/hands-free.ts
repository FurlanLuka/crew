import { createLogger } from '../log.js';
import { INTERRUPT_PATTERN, normalizeUtterance, STANDALONE_WORDS } from '../shared/spoken.js';
import type { Store } from '../state/store.js';
import { countWords } from './echo.js';
import type { SttFailure, SttHandle, SttSessionOptions } from './stt.js';
import { decideTurnAction, joinTurns } from './turns.js';

export interface HandsFreeHost {
	openStream: (options: Omit<SttSessionOptions, 'terms'>) => SttHandle;
	isEcho: (heard: string, isPartial: boolean) => boolean;
	showPartial: (text: string, label?: string) => void;
	clearTranscript: (client: string) => void;
	queueTurn: (client: string, text: string) => void;
	onTalkStarted: () => void;
	onTalkMaybeOver: () => void;
}

export interface HandsFreeOptions {
	store: Store;
	apiKey: string | null;
	// Hands-free turned off for this tab unasked: another tab took over, or the stream failed.
	onListenOff?: (client: string, reason: string) => void;
	now?: () => number;
	computeReconnectDelay?: (attempt: number) => number | null;
	// No new words for this long lets speech play again: background talk can keep a turn open.
	quietMs?: number;
	// An unfinished turn waits this long in silence for the rest.
	holdMs?: number;
}

interface Listening {
	client: string;
	apiKey: string;
	sampleRate: number;
	stream: SttHandle | null;
	attempt: number;
	retryTimer: ReturnType<typeof setTimeout> | null;
	startedAt: number;
	// The developer is mid-turn: Voice OS's speech is cut and held.
	isTalking: boolean;
	quietTimer: ReturnType<typeof setTimeout> | null;
	// A turn that stopped mid-thought, waiting to be joined to the next one.
	heldText: string | null;
	holdTimer: ReturnType<typeof setTimeout> | null;
}

const log = createLogger('voice-in');

const BARGE_IN_WORDS = 2;
const QUIET_MS = 8_000;
const HOLD_MS = 5_000;
const HELD_LABEL = 'waiting for the rest…';
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000];

export const computeReconnectDelay = (attempt: number): number | null => {
	// null once it is time to give up on the dropped stream.
	return RECONNECT_DELAYS_MS[attempt] ?? null;
};

export class HandsFree {
	private listening = new Map<string, Listening>();
	private now: () => number;

	constructor(
		private options: HandsFreeOptions,
		private host: HandsFreeHost,
	) {
		this.now = options.now ?? Date.now;
	}

	hasClient(client: string): boolean {
		return this.listening.has(client);
	}

	get isTalking(): boolean {
		for (const listening of this.listening.values()) {
			if (listening.isTalking) {
				return true;
			}
		}

		return false;
	}

	listen(client: string, apiKey: string, sampleRate: number): void {
		// apiKey is checked by the caller. Only one tab listens at a time.
		for (const otherClient of this.listening.keys()) {
			if (otherClient === client) {
				continue;
			}

			this.unlisten(otherClient);
			this.options.onListenOff?.(otherClient, 'hands-free moved to another tab');
		}

		this.unlisten(client);
		const listening: Listening = {
			client,
			apiKey,
			sampleRate,
			stream: null,
			attempt: 0,
			retryTimer: null,
			startedAt: this.now(),
			isTalking: false,
			quietTimer: null,
			heldText: null,
			holdTimer: null,
		};
		this.listening.set(client, listening);
		log.info('listen start', { client, sampleRate });
		this.connect(listening);
	}

	unlisten(client: string): void {
		const listening = this.listening.get(client);

		if (!listening) {
			return;
		}

		this.listening.delete(client);

		if (listening.retryTimer) {
			clearTimeout(listening.retryTimer);
		}

		this.dropHold(listening);
		listening.stream?.cancel();
		// Soniox bills by the second of audio: the stream's length is its cost.
		log.info('listen stop', {
			client,
			seconds: Math.round((this.now() - listening.startedAt) / 1000),
		});
		this.lowerTalk(listening);
		this.host.clearTranscript(client);
	}

	pushAudio(client: string, chunk: Uint8Array): void {
		// Between a dropped stream and its replacement the audio is lost: at most a few seconds.
		this.listening.get(client)?.stream?.send(chunk);
	}

	private connect(listening: Listening): void {
		const { client } = listening;
		const isCurrentStream = () =>
			this.listening.get(client) === listening && listening.stream === stream;
		const stream = this.host.openStream({
			apiKey: listening.apiKey,
			sampleRate: listening.sampleRate,
			onPartial: (text) => {
				if (isCurrentStream() && text) {
					this.hearPartial(listening, text);
				}
			},
			onSegment: (text) => {
				if (!isCurrentStream()) {
					return;
				}

				listening.attempt = 0;
				this.endTurn(listening, text);
			},
			onFinal: (text) => {
				if (!isCurrentStream()) {
					return;
				}

				// The stream closed under us: its unfinished words still count, then a new stream.
				if (text.trim()) {
					this.endTurn(listening, text);
				}

				this.reconnect(listening, 'stream closed');
			},
			onError: (message: string, cause: SttFailure) => {
				if (!isCurrentStream()) {
					return;
				}

				this.lowerTalk(listening);

				if (cause === 'soniox') {
					this.giveUp(listening, message);

					return;
				}

				this.reconnect(listening, message);
			},
		});
		listening.stream = stream;
	}

	private hearPartial(listening: Listening, text: string): void {
		if (this.host.isEcho(text, true)) {
			return;
		}

		listening.attempt = 0;
		// "stop" and "wait" cut speech as soon as they are heard, not a second later when the turn ends.
		const isStandalone =
			INTERRUPT_PATTERN.test(normalizeUtterance(text)) ||
			STANDALONE_WORDS.has(normalizeUtterance(text));

		// Two real words before speech is cut: a cough or one stray word must not silence it.
		if (!listening.isTalking && (countWords(text) >= BARGE_IN_WORDS || isStandalone)) {
			this.raiseTalk(listening);
		}

		if (listening.isTalking) {
			this.armQuiet(listening);
		}

		if (!listening.heldText) {
			this.host.showPartial(text);

			return;
		}

		// Still speaking: the held start keeps waiting for this.
		this.armHold(listening);
		this.host.showPartial(joinTurns(listening.heldText, text), HELD_LABEL);
	}

	private endTurn(listening: Listening, text: string): void {
		const { client } = listening;

		if (this.host.isEcho(text, false)) {
			log.info('echo dropped', { client, text });

			// A held start still waits for the developer, not for this.
			if (listening.heldText) {
				return;
			}

			this.lowerTalk(listening);
			this.host.clearTranscript(client);

			return;
		}

		const action = decideTurnAction({ held: listening.heldText, text });

		if (listening.heldText) {
			log.info('turn joined', { client, text: action.text });
		}

		this.dropHold(listening);

		// A one-word turn never reached the barge-in threshold; its end still cuts in.
		if (!listening.isTalking) {
			this.raiseTalk(listening);
		}

		if (action.kind === 'hold') {
			log.info('turn held', { client, text: action.text });
			listening.heldText = action.text;
			this.armHold(listening);
			this.host.showPartial(action.text, HELD_LABEL);

			return;
		}

		log.info('heard', { client, text: action.text });
		this.host.queueTurn(client, action.text);
		this.lowerTalk(listening);
		this.host.clearTranscript(client);
	}

	private armHold(listening: Listening): void {
		if (listening.holdTimer) {
			clearTimeout(listening.holdTimer);
		}

		listening.holdTimer = setTimeout(() => {
			const text = listening.heldText;
			listening.holdTimer = null;

			if (!text || this.listening.get(listening.client) !== listening) {
				return;
			}

			// Silence after a held start: routed as it is, so a command held by mistake is not lost.
			listening.heldText = null;
			log.info('held turn released to the kernel', { client: listening.client, text });
			this.host.queueTurn(listening.client, text);
			this.lowerTalk(listening);
			this.host.clearTranscript(listening.client);
		}, this.options.holdMs ?? HOLD_MS);
	}

	private dropHold(listening: Listening): void {
		if (listening.holdTimer) {
			clearTimeout(listening.holdTimer);
		}

		listening.holdTimer = null;
		listening.heldText = null;
	}

	private reconnect(listening: Listening, reason: string): void {
		listening.stream = null;
		const computeDelay = this.options.computeReconnectDelay ?? computeReconnectDelay;
		const delay = computeDelay(listening.attempt);
		listening.attempt += 1;

		if (delay === null) {
			this.giveUp(listening, `the speech stream keeps dropping (${reason})`);

			return;
		}

		log.warn('listen stream dropped, reconnecting', {
			client: listening.client,
			why: reason,
			attempt: listening.attempt,
			delayMs: delay,
		});
		listening.retryTimer = setTimeout(() => {
			listening.retryTimer = null;

			if (this.listening.get(listening.client) === listening) {
				this.connect(listening);
			}
		}, delay);
	}

	private giveUp(listening: Listening, message: string): void {
		this.unlisten(listening.client);
		this.options.store.dispatch({
			type: 'spoken',
			text: `Hands-free stopped: ${message}`,
			source: 'alert',
		});
		this.options.onListenOff?.(listening.client, message);
	}

	private raiseTalk(listening: Listening): void {
		listening.isTalking = true;
		log.info('speech start', { client: listening.client });
		this.host.onTalkStarted();
		this.armQuiet(listening);
	}

	private lowerTalk(listening: Listening): void {
		if (listening.quietTimer) {
			clearTimeout(listening.quietTimer);
		}

		listening.quietTimer = null;

		if (!listening.isTalking) {
			return;
		}

		listening.isTalking = false;
		this.host.onTalkMaybeOver();
	}

	private armQuiet(listening: Listening): void {
		if (listening.quietTimer) {
			clearTimeout(listening.quietTimer);
		}

		listening.quietTimer = setTimeout(() => {
			log.info('turn went quiet without ending, speech may play', { client: listening.client });
			this.lowerTalk(listening);
		}, this.options.quietMs ?? QUIET_MS);
	}
}
