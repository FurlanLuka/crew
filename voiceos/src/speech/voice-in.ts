import { createLogger } from '../log.js';
import { writeSpokenRefs } from '../router/refs.js';
import { describeRouteChip } from '../shared/route-chip.js';
import { isEcho, type SpokenRecord } from './echo.js';
import { HandsFree, type HandsFreeOptions } from './hands-free.js';
import {
	DEFAULT_SAMPLE_RATE_HZ,
	SttSession,
	type SttHandle,
	type SttSessionOptions,
} from './stt.js';
import { buildContextTerms } from './tokens.js';
import { saveDebugWav } from './wav.js';

// store, apiKey, the clock and the hands-free settings come from HandsFreeOptions.
export type VoiceInputOptions = HandsFreeOptions & {
	onUtterance: (text: string) => void;
	onTalkStart: () => void;
	// Nobody is pressing and no hands-free turn is under way: speech may play again.
	onTalkEnd?: () => void;
	// VOICEOS_DEBUG_AUDIO=1: each utterance is saved here as a WAV, to replay a bad transcript.
	debugAudioDir?: string | null;
	// A press whose release never arrives (a key-up lost on blur) is dropped after this.
	maxPressMs?: number;
	createSession?: (options: SttSessionOptions) => SttHandle;
	// What Voice OS said lately: heard again through the open mic, it is echo.
	listSpokenLines?: () => SpokenRecord[];
};

type Outcome = { state: 'streaming' } | { state: 'settled'; text: string | null };

interface Utterance {
	outcome: Outcome;
	client: string;
	stream: SttHandle;
	sampleRate: number;
	chunks: Uint8Array[] | null;
	pressCap: ReturnType<typeof setTimeout>;
}

type Pending = { kind: 'press'; utterance: Utterance } | { kind: 'turn'; text: string };

const log = createLogger('voice-in');

const MAX_PRESS_MS = 60_000;

export class VoiceInput {
	private livePresses = new Map<string, Utterance>();
	private pendingByClient = new Map<string, Pending[]>();
	private handsFree: HandsFree;
	private now: () => number;

	constructor(private options: VoiceInputOptions) {
		this.now = options.now ?? Date.now;
		this.handsFree = new HandsFree(options, {
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
			queueTurn: (client, text) => this.queue(client, { kind: 'turn', text }),
			onTalkStarted: () => this.options.onTalkStart(),
			onTalkMaybeOver: () => this.talkMaybeOver(),
		});
	}

	start(client: string, sampleRate = DEFAULT_SAMPLE_RATE_HZ): void {
		const { store, apiKey } = this.options;

		if (!apiKey) {
			this.announceMissingKey();

			return;
		}

		// The tab's mic already streams hands-free; a press would send the same audio twice.
		if (this.handsFree.hasClient(client)) {
			log.info('push-to-talk ignored while hands-free', { client });

			return;
		}

		// A press without a release before it (a lost key-up): that stream is abandoned.
		// Taken out of live first: the new press follows at once, so talk never ends in between.
		const abandoned = this.livePresses.get(client);

		if (abandoned) {
			this.livePresses.delete(client);
			this.drop(abandoned);
		}

		this.options.onTalkStart();

		log.info('talk start', { client, sampleRate });
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
		const pressCap = setTimeout(() => {
			if (this.livePresses.get(client) !== utterance) {
				return;
			}

			log.warn('press never released, dropping it', { client });
			this.drop(utterance);
		}, this.options.maxPressMs ?? MAX_PRESS_MS);
		utterance = {
			client,
			stream,
			sampleRate,
			chunks: this.options.debugAudioDir ? [] : null,
			outcome: { state: 'streaming' },
			pressCap,
		};
		this.livePresses.set(client, utterance);
		this.queue(client, { kind: 'press', utterance });
	}

	listen(client: string, sampleRate = DEFAULT_SAMPLE_RATE_HZ): void {
		const { apiKey, onListenOff } = this.options;

		if (!apiKey) {
			this.announceMissingKey();
			onListenOff?.(client, 'no Soniox key');

			return;
		}

		this.handsFree.listen(client, apiKey, sampleRate);
	}

	unlisten(client: string): void {
		this.handsFree.unlisten(client);
	}

	pushAudio(client: string, chunk: Uint8Array): void {
		if (this.handsFree.hasClient(client)) {
			this.handsFree.pushAudio(client, chunk);

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

		log.info('talk stop', { client });
		clearTimeout(utterance.pressCap);
		this.endPress(client);
		void utterance.stream.end();
	}

	disconnect(client: string): void {
		this.handsFree.unlisten(client);

		// A copy: settling an utterance shifts the queue this walks.
		// Only presses stream; a hands-free turn is queued already settled.
		for (const pending of [...(this.pendingByClient.get(client) ?? [])]) {
			if (pending.kind === 'press' && pending.utterance.outcome.state === 'streaming') {
				this.drop(pending.utterance);
			}
		}
	}

	private talkMaybeOver(): void {
		// Speech may play again only once nobody is pressing and no hands-free turn is under way.
		if (this.livePresses.size > 0 || this.handsFree.isTalking) {
			return;
		}

		this.options.onTalkEnd?.();
	}

	private openStream(options: Omit<SttSessionOptions, 'terms'>): SttHandle {
		const state = this.options.store.state;
		const terms = buildContextTerms({
			refs: state.order,
			topics: Object.values(state.sessions).map((session) => session.topic ?? ''),
		});
		const createSession =
			this.options.createSession ??
			((sessionOptions: SttSessionOptions) => new SttSession(sessionOptions));

		return createSession({ ...options, terms });
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
			if (text) {
				this.options.onUtterance(text);
			}
		}

		if (queue.length === 0) {
			this.pendingByClient.delete(client);
		}
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
