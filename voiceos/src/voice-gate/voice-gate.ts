// The dry run: learns the developer's voice from turns that are provably theirs, then scores what
// every tab's microphone hears against it — and logs it all, silencing nothing, so a threshold can be
// picked from real voices before any audio is ever held back.
//
// One voiceprint for the process: the developer is one person, and a tab's id changes with every
// reconnect. What each tab hears (VAD state, the recent audio, the gate) is its own.

import { createLogger } from '../log.js';
import type { ListenMode, VoiceGateStatus } from '../shared/protocol.js';
import { ClientStream } from './client-stream.js';
import { CHUNK_SECONDS, chunkSpeech, cosine, decideLockIn, LOCK_IN_RULE } from './enrollment.js';
import { SAMPLE_RATE } from './gate.js';
import type { Embed, Vad } from './models.js';
import { scoreTurn, speechInSpan } from './turns.js';

const log = createLogger('voice-gate');

const SPEECH_ON = 0.5;
const LEARN_SECONDS = LOCK_IN_RULE.minChunks * CHUNK_SECONDS;
// The first transcript reaches a listened turn about half a second after the words began.
const TURN_PAD_MS = 1_000;

// A turn Voice OS acted on, with the span its words were heard in.
export interface HeardTurn {
	from: number;
	to: number;
	source: ListenMode;
}

export interface VoiceGateParams {
	createVad: () => Vad;
	embed: Embed;
	setStatus: (status: VoiceGateStatus) => void;
	now: () => number;
	isVoiceOsSpeaking: () => boolean;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export class VoiceGate {
	private streams = new Map<string, ClientStream>();
	private embeddings: Float32Array[] = [];
	private rest: Float32Array = new Float32Array(0);
	private voiceprint: Float32Array | null = null;
	// Turns are learned one after another: each adds to the same pool.
	private learning: Promise<void> = Promise.resolve();
	private status: VoiceGateStatus | null = null;

	constructor(private params: VoiceGateParams) {
		this.setStatus({ phase: 'learning', seconds: 0, of: LEARN_SECONDS });
	}

	observe(client: string, chunk: Uint8Array, sampleRate: number): void {
		this.streamOf(client).observe(chunk, sampleRate);
	}

	turnDelivered(client: string, turn: HeardTurn): Promise<void> {
		const stream = this.streams.get(client);

		// Typed words, or a tab whose audio never reached the gate.
		if (!stream) {
			return Promise.resolve();
		}

		if (this.voiceprint) {
			return this.scoreTurn(stream, turn);
		}

		const learned = this.learning.then(() => this.learn(stream, turn));

		// One failed turn (a model error) must not stop every later turn from being learned.
		this.learning = learned.catch(() => undefined);

		return learned;
	}

	forget(client: string): void {
		const stream = this.streams.get(client);

		if (!stream) {
			return;
		}

		stream.close();
		this.streams.delete(client);
		log.info('forget', { client });
	}

	private streamOf(client: string): ClientStream {
		let stream = this.streams.get(client);

		if (!stream) {
			stream = new ClientStream({
				client,
				createVad: this.params.createVad,
				now: this.params.now,
				isVoiceOsSpeaking: this.params.isVoiceOsSpeaking,
			});

			if (this.voiceprint) {
				stream.startScoring(this.createScorer(this.voiceprint));
			}

			this.streams.set(client, stream);
		}

		return stream;
	}

	private get learnedSeconds(): number {
		return Math.floor(this.embeddings.length * CHUNK_SECONDS + this.rest.length / SAMPLE_RATE);
	}

	private async learn(stream: ClientStream, turn: HeardTurn): Promise<void> {
		const speech = await stream.after(() =>
			speechInSpan({ ring: stream.ring, from: turn.from, to: turn.to, speechOn: SPEECH_ON }),
		);

		// A voiceprint locked in while this turn waited behind another: it is scored instead.
		if (this.voiceprint) {
			return this.scoreTurn(stream, turn);
		}

		const pool = new Float32Array(this.rest.length + speech.audio.length);

		pool.set(this.rest);
		pool.set(speech.audio, this.rest.length);

		const { chunks, rest } = chunkSpeech(pool, CHUNK_SECONDS * SAMPLE_RATE);

		this.rest = rest;

		for (const chunk of chunks) {
			this.embeddings.push(await this.params.embed(chunk));
		}

		log.info('learn', {
			client: stream.client,
			source: turn.source,
			sampleRate: stream.sampleRate,
			speechSeconds: round(speech.audio.length / SAMPLE_RATE),
			skippedWhileSpeaking: speech.skipped,
			learnedSeconds: this.learnedSeconds,
		});

		const decision = decideLockIn(this.embeddings);
		const fits = decision.fits.map(round);

		if (decision.kind === 'collecting') {
			this.embeddings = decision.kept;

			if (fits.length > 0) {
				log.info('not locked in: chunks disagree', { chunks: fits.length, fits });
			}

			this.setStatus({ phase: 'learning', seconds: this.learnedSeconds, of: LEARN_SECONDS });

			return;
		}

		this.voiceprint = decision.voiceprint;
		log.info('locked in', {
			chunks: fits.length,
			minFit: Math.min(...fits),
			meanFit: round(fits.reduce((sum, fit) => sum + fit, 0) / fits.length),
		});

		for (const each of this.streams.values()) {
			each.startScoring(this.createScorer(decision.voiceprint));
		}

		this.setStatus({ phase: 'scoring', lastScore: null });
	}

	private async scoreTurn(stream: ClientStream, turn: HeardTurn): Promise<void> {
		const scored = await stream.after(async () => {
			// A released key sends no more audio: whatever it was still deciding is decided now — unless
			// the next press already started, whose words are still coming.
			if (turn.source === 'push' && (stream.ring.at(-1)?.at ?? 0) <= turn.to) {
				await stream.finishUtterance();
			}

			return scoreTurn({ scores: stream.scores, from: turn.from, to: turn.to, padMs: TURN_PAD_MS });
		});
		const lastScore = scored.scores.at(-1)?.score;

		log.info('turn scored', {
			client: stream.client,
			source: turn.source,
			sampleRate: stream.sampleRate,
			seconds: round((turn.to - turn.from) / 1000),
			scores: scored.scores.map((score) => round(score.score)),
			verdict: scored.verdict,
		});

		if (lastScore !== undefined) {
			this.setStatus({ phase: 'scoring', lastScore: round(lastScore) });
		}
	}

	// Every change is replayed in every open page: the same status twice is not sent.
	private setStatus(status: VoiceGateStatus): void {
		if (JSON.stringify(status) === JSON.stringify(this.status)) {
			return;
		}

		this.status = status;
		this.params.setStatus(status);
	}

	private createScorer(voiceprint: Float32Array) {
		return async (audio: Float32Array): Promise<number> =>
			cosine(await this.params.embed(audio), voiceprint);
	}
}
