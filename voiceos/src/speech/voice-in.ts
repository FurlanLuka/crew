import { createLogger } from '../log.js';
import { writeSpokenRefs } from '../router/refs.js';
import type { ListenMode, ListeningMode } from '../shared/protocol.js';
import { describeRouteChip } from '../shared/route-chip.js';
import { isEcho, type SpokenRecord } from './echo.js';
import { Listener, type ListenerOptions } from './listener.js';
import {
	DEFAULT_SAMPLE_RATE_HZ,
	SttSession,
	type SttHandle,
	type SttSessionOptions,
} from './stt.js';
import { buildContextTerms } from './tokens.js';
import { saveDebugWav } from './wav.js';

// store, apiKey, the clock and the listening settings come from ListenerOptions.
export type VoiceInputOptions = ListenerOptions & {
	// client: the tab whose microphone heard it.
	// startedAt: when the developer began saying it (a joined turn: its first words); lines Voice OS
	// started after that were not heard before they spoke.
	// isDictated: a dictation, sent word for word to the session on screen rather than routed.
	onUtterance: (
		text: string,
		client: string,
		startedAt: number,
		heard: { isDictated: boolean },
	) => void;
	onTalkStart: () => void;
	// Nobody is pressing and no listened turn is under way: speech may play again.
	onTalkEnd?: () => void;
	// VOICEOS_DEBUG_AUDIO=1: each utterance is saved here as a WAV, to replay a bad transcript.
	debugAudioDir?: string | null;
	// A press whose release never arrives (a key-up lost on blur) is ended after this, its words kept.
	maxPressMs?: number;
	// A dictation is sent after this, never dropped.
	maxDictationMs?: number;
	createSession?: (options: SttSessionOptions) => SttHandle;
	// What Voice OS said lately: heard again through the open mic, it is echo.
	listSpokenLines?: () => SpokenRecord[];
	// On demand: a call opened or closed, and speech left alone, for the tab to show.
	onListenState?: (client: string, isAwake: boolean) => void;
	onHeardIgnored?: (client: string) => void;
	// A press that never got its release: its words go back to the tab's input, never to a session.
	onKept?: (text: string, client: string, reason: string) => void;
};

type Outcome = { state: 'streaming' } | { state: 'settled'; text: string | null };

interface Utterance {
	outcome: Outcome;
	client: string;
	stream: SttHandle;
	sampleRate: number;
	chunks: Uint8Array[] | null;
	pressCap: ReturnType<typeof setTimeout>;
	// When the press began: what Voice OS started saying after that, the developer had not heard.
	startedAt: number;
	// A dictation: held open until sent, and never dropped with its words — ended and sent instead.
	isDictation: boolean;
	// Released (or ended for it): its stream is finalizing, and ending it again would do nothing good.
	isReleased: boolean;
	// Why its words are kept for the input instead of routed; null for a press that was released.
	keptReason: string | null;
}

type Pending =
	| { kind: 'press'; utterance: Utterance }
	| { kind: 'turn'; text: string; startedAt: number };

const log = createLogger('voice-in');

// A held button: long enough for a long thought said in one go; past it the press is taken as stuck.
export const MAX_PRESS_MS = 2 * 60_000;

// A brain dump runs long; Soniox takes 300 minutes a stream, so this cap is about a forgotten mic.
const MAX_DICTATION_MS = 30 * 60_000;

export interface StartOptions {
	isDictation?: boolean;
}

// Long enough for the heard words to be seen (and captured) before they are routed.
const SIMULATED_TALK_MS = 1_200;

export class VoiceInput {
	private livePresses = new Map<string, Utterance>();
	private pendingByClient = new Map<string, Pending[]>();
	private listener: Listener;
	private now: () => number;

	constructor(private options: VoiceInputOptions) {
		this.now = options.now ?? Date.now;
		this.listener = new Listener(options, {
			openStream: (streamOptions) => this.openStream(streamOptions),
			isEcho: (heard, isPartial) =>
				isEcho({
					heard,
					spoken: this.options.listSpokenLines?.() ?? [],
					now: this.now(),
					isPartial,
				}),
			showPartial: (text, label) => this.showPartial(text, label),
			clearTranscript: (client) => this.clearTranscript(client),
			queueTurn: (client, text, startedAt) => this.queue(client, { kind: 'turn', text, startedAt }),
			onTalkStarted: () => this.options.onTalkStart(),
			onTalkMaybeOver: () => this.talkMaybeOver(),
			onListenState: (client, isAwake) => this.options.onListenState?.(client, isAwake),
			onHeardIgnored: (client) => this.options.onHeardIgnored?.(client),
		});
	}

	start(
		client: string,
		sampleRate = DEFAULT_SAMPLE_RATE_HZ,
		{ isDictation = false }: StartOptions = {},
	): void {
		const { store, apiKey } = this.options;

		if (!apiKey) {
			this.announceMissingKey();

			return;
		}

		// The tab's mic already streams (on demand or hands-free); a press would send the same audio twice.
		if (this.listener.hasClient(client)) {
			log.info('push-to-talk ignored while listening', { client });

			return;
		}

		// A press without a release before it (a lost key-up): that stream is abandoned.
		// Taken out of live first: the new press follows at once, so talk never ends in between.
		const abandoned = this.livePresses.get(client);

		if (abandoned) {
			this.livePresses.delete(client);
			this.endStuck(abandoned, 'a new press began');
		}

		const startedAt = this.now();
		this.options.onTalkStart();

		log.info(isDictation ? 'dictation start' : 'talk start', { client, sampleRate });
		// The callbacks only run after the stream exists, so they can close over it.
		let utterance: Utterance;
		const stream = this.openStream({
			apiKey,
			sampleRate,
			onPartial: (text) => {
				if (this.livePresses.get(client) === utterance) {
					this.showPartial(text);
				}
			},
			onFinal: (text) => {
				this.saveRecording(utterance, text);
				this.settle(utterance, text.trim() ? text : null);
			},
			onError: (message) => {
				store.dispatch({
					type: 'spoken',
					text: `Speech recognition failed: ${message}`,
					source: 'alert',
				});
				this.settle(utterance, null);
			},
		});
		const pressCap = setTimeout(
			() => {
				if (this.livePresses.get(client) !== utterance) {
					return;
				}

				this.endStuck(utterance, 'the press reached its limit');
			},
			isDictation
				? (this.options.maxDictationMs ?? MAX_DICTATION_MS)
				: (this.options.maxPressMs ?? MAX_PRESS_MS),
		);
		utterance = {
			client,
			stream,
			sampleRate,
			chunks: this.options.debugAudioDir ? [] : null,
			outcome: { state: 'streaming' },
			pressCap,
			startedAt,
			isDictation,
			isReleased: false,
			keptReason: null,
		};
		this.livePresses.set(client, utterance);
		this.queue(client, { kind: 'press', utterance });
	}

	listen(
		client: string,
		sampleRate = DEFAULT_SAMPLE_RATE_HZ,
		mode: ListeningMode = 'hands-free',
	): void {
		const { apiKey, onListenOff } = this.options;
		const dictation = this.livePresses.get(client);

		// Listening takes the mic's audio from here on: a dictation under way is sent, not starved.
		if (dictation?.isDictation) {
			this.letGo(dictation, 'listening turned on');
		}

		if (!apiKey) {
			this.announceMissingKey();
			onListenOff?.(client, 'no Soniox key');

			return;
		}

		this.listener.listen(client, apiKey, sampleRate, mode);
	}

	isListening(): boolean {
		return this.listener.hasListeners;
	}

	listenModeOf(client: string): ListenMode {
		return this.listener.modeOf(client) ?? 'push';
	}

	unlisten(client: string): void {
		this.listener.unlisten(client);
	}

	pushAudio(client: string, chunk: Uint8Array): void {
		if (this.listener.hasClient(client)) {
			this.listener.pushAudio(client, chunk);

			return;
		}

		const utterance = this.livePresses.get(client);

		if (!utterance) {
			return;
		}

		utterance.stream.send(chunk);
		utterance.chunks?.push(new Uint8Array(chunk));
	}

	stop(client: string): void {
		const utterance = this.livePresses.get(client);

		if (!utterance) {
			return;
		}

		this.finish(utterance);
	}

	// Discard: the dictation (or press) under way is thrown away, nothing is routed.
	cancel(client: string): void {
		const utterance = this.livePresses.get(client);

		if (!utterance) {
			return;
		}

		log.info(utterance.isDictation ? 'dictation discarded' : 'talk discarded', {
			client,
			durationMs: this.now() - utterance.startedAt,
		});
		this.drop(utterance);
	}

	// Debug: words go the way a finished spoken turn goes — shown as heard while "said", then
	// routed — without a microphone or Soniox. main.ts only lets this through behind a flag.
	simulate(client: string, text: string, holdMs = SIMULATED_TALK_MS): void {
		const startedAt = this.now();

		log.info('simulated speech', { client, chars: text.length });
		this.options.onTalkStart();
		this.showPartial(text);
		setTimeout(() => {
			this.clearTranscript(client);
			this.queue(client, { kind: 'turn', text, startedAt });
			this.talkMaybeOver();
		}, holdMs);
	}

	disconnect(client: string): void {
		this.listener.unlisten(client);

		// A copy: settling an utterance shifts the queue this walks.
		// Only presses stream; a listened turn is queued already settled.
		for (const pending of [...(this.pendingByClient.get(client) ?? [])]) {
			if (pending.kind === 'press' && pending.utterance.outcome.state === 'streaming') {
				this.letGo(pending.utterance, 'the tab went away');
			}
		}
	}

	private talkMaybeOver(): void {
		// Speech may play again only once nobody is pressing and no listened turn is under way.
		if (this.livePresses.size > 0 || this.listener.isTalking) {
			return;
		}

		this.options.onTalkEnd?.();
	}

	private openStream(options: Omit<SttSessionOptions, 'terms'>): SttHandle {
		const state = this.options.store.state;
		const terms = buildContextTerms({
			refs: state.order,
			machineNames: Object.values(state.machines).map((machine) => machine.name),
			sessionNames: Object.values(state.names),
		});
		const createSession =
			this.options.createSession ??
			((sessionOptions: SttSessionOptions) => new SttSession(sessionOptions));

		return createSession({ ...options, terms, languages: state.languages });
	}

	private showPartial(text: string, label?: string): void {
		const { store } = this.options;
		const target = label ?? describeRouteChip(store.state).label;
		const shown = writeSpokenRefs({ text, refs: store.state.order });
		store.dispatch({ type: 'transcript', transcript: { text: shown, isFinal: false, target } });
	}

	private clearTranscript(client: string): void {
		// Another tab's press may still be showing its words.
		if (!this.livePresses.has(client)) {
			this.options.store.dispatch({ type: 'transcript', transcript: null });
		}
	}

	private announceMissingKey(): void {
		this.options.store.dispatch({
			type: 'spoken',
			text: 'Voice input needs a Soniox key — see the banner.',
			source: 'alert',
		});
	}

	private endPress(client: string): void {
		this.livePresses.delete(client);
		this.talkMaybeOver();
	}

	// Ends the press and sends what it heard.
	private finish(utterance: Utterance): void {
		if (utterance.isReleased) {
			return;
		}

		utterance.isReleased = true;
		log.info(utterance.isDictation ? 'dictation stop' : 'talk stop', {
			client: utterance.client,
			durationMs: this.now() - utterance.startedAt,
		});
		clearTimeout(utterance.pressCap);

		if (this.livePresses.get(utterance.client) === utterance) {
			this.endPress(utterance.client);
		}

		void utterance.stream.end();
	}

	// A press whose release never came (its cap, or a new press from the same tab): a dictation is
	// sent as it always is. A plain press was not let go, so what it heard is not taken as a turn —
	// it may be a minute of the room — but neither is it lost (debug note 30): its words go to the
	// input, to send from there.
	private endStuck(utterance: Utterance, why: string): void {
		if (utterance.isDictation) {
			log.warn('dictation ended without a release: sent', { client: utterance.client, why });
			this.finish(utterance);

			return;
		}

		log.warn('press ended without a release: kept', { client: utterance.client, why });
		utterance.keptReason = why;
		this.finish(utterance);
	}

	// A press cut short by something else: a dictation's words are sent, a plain press is dropped.
	private letGo(utterance: Utterance, why: string): void {
		if (utterance.isDictation) {
			log.info('dictation ended early: sent', { client: utterance.client, why });
			this.finish(utterance);

			return;
		}

		this.drop(utterance);
	}

	private drop(utterance: Utterance): void {
		utterance.stream.cancel();
		this.settle(utterance, null);
	}

	private settle(utterance: Utterance, text: string | null): void {
		if (utterance.outcome.state === 'settled') {
			return;
		}

		utterance.outcome = { state: 'settled', text };
		clearTimeout(utterance.pressCap);

		if (this.livePresses.get(utterance.client) === utterance) {
			this.endPress(utterance.client);
		}

		this.clearTranscript(utterance.client);
		this.flush(utterance.client);
	}

	private queue(client: string, pending: Pending): void {
		this.pendingByClient.set(client, [...(this.pendingByClient.get(client) ?? []), pending]);
		this.flush(client);
	}

	private flush(client: string): void {
		// Routed in each tab's press order: a quick "stop" that finalizes early still waits its turn.
		const queue = this.pendingByClient.get(client) ?? [];

		for (let head = queue[0]; head; head = queue[0]) {
			const text =
				head.kind === 'turn'
					? head.text
					: head.utterance.outcome.state === 'settled'
						? head.utterance.outcome.text
						: undefined;

			// A press still streaming holds the rest of the queue.
			if (text === undefined) {
				break;
			}

			queue.shift();

			// null: nothing to route (silence, an error, a cancelled stream).
			if (text && head.kind === 'press' && head.utterance.keptReason) {
				this.keep(text, client, head.utterance.keptReason);
			} else if (text) {
				this.options.onUtterance(
					text,
					client,
					head.kind === 'turn' ? head.startedAt : head.utterance.startedAt,
					{ isDictated: head.kind === 'press' && head.utterance.isDictation },
				);
			}
		}

		if (queue.length === 0) {
			this.pendingByClient.delete(client);
		}
	}

	private keep(text: string, client: string, reason: string): void {
		log.info('press kept in the input', { client, reason, chars: text.length });
		this.options.onKept?.(text, client, reason);
		this.options.store.dispatch({
			type: 'spoken',
			text: 'Not sent — what you said is in the text box.',
			source: 'alert',
		});
	}

	private saveRecording(utterance: Utterance, text: string): void {
		const directory = this.options.debugAudioDir;

		if (!utterance.chunks || !directory) {
			return;
		}

		try {
			log.info(
				'debug audio saved',
				saveDebugWav({
					dir: directory,
					chunks: utterance.chunks,
					sampleRate: utterance.sampleRate,
					text,
				}),
			);
		} catch (error) {
			log.warn('debug audio not saved', { error: String(error) });
		}
	}
}
