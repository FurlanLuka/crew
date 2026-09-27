import { createLogger } from '../log.js';
import { INTERRUPT_PATTERN, normalizeUtterance, STANDALONE_WORDS } from '../shared/spoken.js';
import type { Store } from '../state/store.js';
import { countWords } from './echo.js';
import type { SttFailure, SttHandle, SttSessionOptions } from './stt.js';
import { decideTurnAction, hasRealWords, joinTurns, type HoldKind } from './turns.js';

export interface HandsFreeHost {
	openStream: (options: Omit<SttSessionOptions, 'terms'>) => SttHandle;
	isEcho: (heard: string, isPartial: boolean) => boolean;
	showPartial: (text: string, label?: string) => void;
	clearTranscript: (client: string) => void;
	// startedAt: when the turn's first words began (a joined turn: the first part's).
	queueTurn: (client: string, text: string, startedAt: number) => void;
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
	// A finished turn waits this long in case the developer goes on: endpointing cuts sentences.
	continueMs?: number;
	// No turn waits longer than this in all, so background talk cannot hold a command back.
	maxWaitMs?: number;
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
	// A turn waiting to be joined to the next one: unfinished (hold) or finished (settle).
	heldText: string | null;
	holdKind: HoldKind | null;
	heldSince: number | null;
	holdTimer: ReturnType<typeof setTimeout> | null;
	// When the words of the turn under way began; null between turns.
	turnStartedAt: number | null;
}

const log = createLogger('voice-in');

const BARGE_IN_WORDS = 2;
const QUIET_MS = 8_000;
const HOLD_MS = 5_000;
// Speech-to-text reports new words about half a second after they start: 1.2 s missed a
// developer who went on 0.7 s after pausing.
const CONTINUE_MS = 2_000;
// Only a backstop against background talk that never pauses: the developer's own turn goes when
// they pause, however long it runs (8 s cut a developer mid-sentence into two requests).
export const MAX_WAIT_MS = 120_000;
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
			holdKind: null,
			heldSince: null,
			holdTimer: null,
			turnStartedAt: null,
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

		// A finished command still waiting is the developer's: listening ends, the command still goes.
		if (listening.holdKind === 'settle' && listening.heldText) {
			log.info('settled turn routed as listening ended', { client, text: listening.heldText });
			this.route(listening, listening.heldText);
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

		if (listening.holdKind === 'settle' && !hasRealWords(text)) {
			return;
		}

		// Still speaking: the held start keeps waiting for this.
		this.armHold(listening, this.options.holdMs ?? HOLD_MS);
		this.host.showPartial(
			joinTurns(listening.heldText, text, { keepBoundary: listening.holdKind === 'settle' }),
			listening.holdKind === 'hold' ? HELD_LABEL : undefined,
		);
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

		const action = decideTurnAction({
			held: listening.heldText,
			heldKind: listening.holdKind,
			text,
		});

		if (action.kind === 'cancel') {
			// Nothing was sent yet: "stop" drops it, and still reaches whatever runs.
			log.info('held turn cancelled', { client, held: listening.heldText, text });
			this.dropHold(listening);
			this.route(listening, action.text);
			this.lowerTalk(listening);
			this.host.clearTranscript(client);

			return;
		}

		if (listening.heldText) {
			log.info('turn joined', { client, text: action.text });
		}

		// The cap counts from the first finished sentence, whatever the joins turn it into after;
		// an unfinished hold with nothing finished before it waits as it always has.
		const heldSince = listening.heldSince ?? (action.kind === 'settle' ? this.now() : null);
		this.dropHold(listening);

		// A one-word turn never reached the barge-in threshold; its end still cuts in.
		if (!listening.isTalking) {
			this.raiseTalk(listening);
		}

		const maxWaitMs = this.options.maxWaitMs ?? MAX_WAIT_MS;
		const isCapped = heldSince !== null && this.now() - heldSince >= maxWaitMs;

		if (isCapped) {
			log.info('wait capped', { client, text: action.text });
		}

		if (action.kind !== 'route' && !isCapped) {
			log.info(action.kind === 'hold' ? 'turn held' : 'turn settling', {
				client,
				text: action.text,
			});
			listening.heldText = action.text;
			listening.holdKind = action.kind;
			listening.heldSince = heldSince;
			this.armHold(
				listening,
				action.kind === 'hold'
					? (this.options.holdMs ?? HOLD_MS)
					: (this.options.continueMs ?? CONTINUE_MS),
			);
			this.host.showPartial(action.text, action.kind === 'hold' ? HELD_LABEL : undefined);

			return;
		}

		log.info('heard', { client, text: action.text });
		this.route(listening, action.text);
		this.lowerTalk(listening);
		this.host.clearTranscript(client);
	}

	private armHold(listening: Listening, ms: number): void {
		if (listening.holdTimer) {
			clearTimeout(listening.holdTimer);
		}

		// Never past the cap: background talk keeps re-arming this.
		const maxWaitMs = this.options.maxWaitMs ?? MAX_WAIT_MS;
		const left = listening.heldSince === null ? ms : maxWaitMs - (this.now() - listening.heldSince);

		listening.holdTimer = setTimeout(
			() => {
				const text = listening.heldText;
				listening.holdTimer = null;

				if (!text || this.listening.get(listening.client) !== listening) {
					return;
				}

				// Silence: a finished sentence goes as it is; an unfinished one too, so a command held by
				// mistake is not lost.
				const waitMs = listening.heldSince === null ? null : this.now() - listening.heldSince;
				const event =
					waitMs !== null && waitMs >= maxWaitMs
						? 'wait capped'
						: listening.holdKind === 'settle'
							? 'settled turn routed'
							: 'held turn released to the kernel';
				log.info(event, { client: listening.client, text, ...(waitMs === null ? {} : { waitMs }) });
				this.dropHold(listening);
				this.route(listening, text);
				this.lowerTalk(listening);
				this.host.clearTranscript(listening.client);
			},
			Math.max(0, Math.min(ms, left)),
		);
	}

	private dropHold(listening: Listening): void {
		if (listening.holdTimer) {
			clearTimeout(listening.holdTimer);
		}

		listening.holdTimer = null;
		listening.heldText = null;
		listening.holdKind = null;
		listening.heldSince = null;
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

	private route(listening: Listening, text: string): void {
		const startedAt = listening.turnStartedAt ?? this.now();
		listening.turnStartedAt = null;
		this.host.queueTurn(listening.client, text, startedAt);
	}

	private raiseTalk(listening: Listening): void {
		listening.isTalking = true;
		listening.turnStartedAt ??= this.now();
		log.info('speech start', { client: listening.client });
		this.host.onTalkStarted();
		this.armQuiet(listening);
	}

	private lowerTalk(listening: Listening): void {
		if (listening.quietTimer) {
			clearTimeout(listening.quietTimer);
		}

		listening.quietTimer = null;

		// Speech that became no turn (a murmur, echo, background talk): the next turn starts afresh.
		if (!listening.heldText) {
			listening.turnStartedAt = null;
		}

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
