// The dry run: learns the developer's voice from turns that are provably theirs, then scores what
// every tab's microphone hears against it — and logs it all, silencing nothing, so a threshold can be
// picked from real voices before any audio is ever held back.
//
// One voiceprint for the process: the developer is one person, and a tab's id changes with every
// reconnect. What each tab hears (VAD state, the recent audio, the gate) is its own. After lock-in
// it keeps learning from turns that are clearly the developer's (adaptation.ts), and it is saved,
// so a restart resumes instead of starting over.

import { createLogger } from '../log.js';
import type { ListenMode, VoiceGateStatus } from '../shared/protocol.js';
import { ClientStream } from './client-stream.js';
import { adaptVoice, isTrained, type LearnedVoice, rollingAverage } from './adaptation.js';
import { CHUNK_SECONDS, chunkSpeech, cosine, decideLockIn, LOCK_IN_RULE } from './enrollment.js';
import { SAMPLE_RATE } from './gate.js';
import type { Embed, Vad } from './models.js';
import { scoreTurn, speechInSpan } from './turns.js';

const log = createLogger('voice-gate');

const SPEECH_ON = 0.5;
const LEARN_SECONDS = LOCK_IN_RULE.minChunks * CHUNK_SECONDS;
// The first transcript reaches a listened turn about half a second after the words began.
const TURN_PAD_MS = 1_000;
// A long turn is judged by its latest words: each chunk is one embed on the event loop.
const MAX_TURN_CHUNKS = 5;

// A turn Voice OS acted on, with the span its words were heard in.
export interface HeardTurn {
	from: number;
	to: number;
	source: ListenMode;
}

export type { LearnedVoice } from './adaptation.js';

export interface VoiceStore {
	save: (voice: LearnedVoice) => void;
	delete: () => void;
}

export interface VoiceGateParams {
	createVad: () => Vad;
	embed: Embed;
	setStatus: (status: VoiceGateStatus) => void;
	now: () => number;
	isVoiceOsSpeaking: () => boolean;
	store: VoiceStore;
	// A voice saved by an earlier run: scoring starts at once.
	initial?: LearnedVoice | null;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export class VoiceGate {
	private streams = new Map<string, ClientStream>();
	private embeddings: Float32Array[] = [];
	private rest: Float32Array = new Float32Array(0);
	private voice: LearnedVoice | null;
	// Turns are read one after another: each adds to the same pool or the same voiceprint.
	private learning: Promise<void> = Promise.resolve();
	private status: VoiceGateStatus | null = null;
	private lastScore: number | null = null;
	private skippedSince = 0;
	// Bumped by forgetVoice: a turn begun before it finds the number changed and leaves everything be.
	private generation = 0;

	constructor(private params: VoiceGateParams) {
		this.voice = params.initial ?? null;
		this.setStatus(
			this.voice ? this.scoringStatus : { phase: 'learning', seconds: 0, of: LEARN_SECONDS },
		);
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

		const generation = this.generation;
		const learned = this.learning.then(() =>
			this.voice ? this.scoreTurn(stream, turn, generation) : this.learn(stream, turn, generation),
		);

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

	// The developer asked to start over: the saved voice goes, and learning begins again.
	forgetVoice(): void {
		this.generation += 1;
		this.voice = null;
		this.embeddings = [];
		this.rest = new Float32Array(0);
		this.lastScore = null;
		this.skippedSince = 0;

		for (const stream of this.streams.values()) {
			stream.stopScoring();
		}

		try {
			this.params.store.delete();
		} catch (error) {
			log.warn('voiceprint not deleted', { error: String(error) });
		}

		log.info('voiceprint forgotten');
		this.setStatus({ phase: 'learning', seconds: 0, of: LEARN_SECONDS });
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

			if (this.voice) {
				stream.startScoring(this.scorer);
			}

			this.streams.set(client, stream);
		}

		return stream;
	}

	private get learnedSeconds(): number {
		return Math.floor(this.embeddings.length * CHUNK_SECONDS + this.rest.length / SAMPLE_RATE);
	}

	private get scoringStatus(): VoiceGateStatus {
		return {
			phase: 'scoring',
			lastScore: this.lastScore,
			average: this.average,
			isTrained: isTrained(this.voice?.recentScores ?? []),
		};
	}

	private get average(): number | null {
		const average = rollingAverage(this.voice?.recentScores ?? []);

		return average === null ? null : round(average);
	}

	private async learn(stream: ClientStream, turn: HeardTurn, generation: number): Promise<void> {
		const speech = await stream.after(() =>
			speechInSpan({ ring: stream.ring, from: turn.from, to: turn.to, speechOn: SPEECH_ON }),
		);

		if (generation !== this.generation) {
			return;
		}

		const pool = new Float32Array(this.rest.length + speech.audio.length);

		pool.set(this.rest);
		pool.set(speech.audio, this.rest.length);

		const { chunks, rest } = chunkSpeech(pool, CHUNK_SECONDS * SAMPLE_RATE);

		this.rest = rest;

		for (const chunk of chunks) {
			const embedding = await this.params.embed(chunk);

			if (generation !== this.generation) {
				return;
			}

			this.embeddings.push(embedding);
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

		this.voice = {
			voiceprint: decision.voiceprint,
			enrolled: decision.voiceprint,
			recentScores: [],
			turns: 0,
		};
		this.embeddings = [];
		this.rest = new Float32Array(0);
		this.save();
		log.info('locked in', {
			chunks: fits.length,
			minFit: Math.min(...fits),
			meanFit: round(fits.reduce((sum, fit) => sum + fit, 0) / fits.length),
		});

		for (const each of this.streams.values()) {
			each.startScoring(this.scorer);
		}

		this.setStatus(this.scoringStatus);
	}

	private async scoreTurn(
		stream: ClientStream,
		turn: HeardTurn,
		generation: number,
	): Promise<void> {
		const { scored, speech } = await stream.after(async () => {
			// A released key sends no more audio: whatever it was still deciding is decided now — unless
			// the next press already started, whose words are still coming.
			if (turn.source === 'push' && (stream.ring.at(-1)?.at ?? 0) <= turn.to) {
				await stream.finishUtterance();
			}

			return {
				scored: scoreTurn({
					scores: stream.scores,
					from: turn.from,
					to: turn.to,
					padMs: TURN_PAD_MS,
				}),
				speech: speechInSpan({
					ring: stream.ring,
					from: turn.from,
					to: turn.to,
					speechOn: SPEECH_ON,
				}),
			};
		});

		if (generation !== this.generation) {
			return;
		}

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
			this.lastScore = round(lastScore);
			// Shown now: learning from the turn takes several embeds, and may fail.
			this.setStatus(this.scoringStatus);
		}

		await this.adapt(stream, turn, speech.audio, generation);

		if (generation === this.generation) {
			this.setStatus(this.scoringStatus);
		}
	}

	// The turn, measured the way the voiceprint was built (3 s chunks, averaged), before it is blended in.
	private async adapt(
		stream: ClientStream,
		turn: HeardTurn,
		audio: Float32Array,
		generation: number,
	): Promise<void> {
		const { chunks } = chunkSpeech(audio, CHUNK_SECONDS * SAMPLE_RATE);

		if (chunks.length === 0) {
			log.info('not adapted', { client: stream.client, reason: 'too short' });

			return;
		}

		const embeddings: Float32Array[] = [];

		for (const chunk of chunks.slice(-MAX_TURN_CHUNKS)) {
			const embedding = await this.params.embed(chunk);

			if (generation !== this.generation) {
				return;
			}

			embeddings.push(embedding);
		}

		const adapted = adaptVoice({
			voice: this.voice as LearnedVoice,
			embeddings,
			source: turn.source,
		});
		const { decision, scores, isDeveloper } = adapted;
		const fields = {
			client: stream.client,
			source: turn.source,
			turnScore: round(scores.turnScore),
			enrolledScore: round(scores.enrolledScore),
		};

		this.voice = adapted.voice;

		if (decision.kind === 'skip') {
			this.skippedSince += 1;
			log.info('not adapted', { ...fields, reason: decision.reason, counted: isDeveloper });
		} else {
			log.info('adapted', {
				...fields,
				weight: decision.weight,
				average: this.average,
				isTrained: isTrained(adapted.voice.recentScores),
				turns: adapted.voice.turns,
				skippedSince: this.skippedSince,
			});
			this.skippedSince = 0;
		}

		// A turn that counts changes the voice (its score at least), and only such a turn does.
		if (isDeveloper) {
			this.save();
		}
	}

	// A write that fails leaves the learning in memory: this run goes on, the next starts from the last save.
	private save(): void {
		if (!this.voice) {
			return;
		}

		try {
			this.params.store.save(this.voice);
			log.info('voiceprint saved', { turns: this.voice.turns });
		} catch (error) {
			log.warn('voiceprint save failed', { error: String(error) });
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

	// Reads the voiceprint at each score, so windows are scored against what was learned since.
	private scorer = async (audio: Float32Array): Promise<number> => {
		const embedding = await this.params.embed(audio);

		return this.voice ? cosine(embedding, this.voice.voiceprint) : 0;
	};
}
