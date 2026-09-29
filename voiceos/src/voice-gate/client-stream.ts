// One tab's microphone as the voice gate hears it. Chunks arrive synchronously from the socket; the
// models answer asynchronously, and Silero's state and the gate both need frames strictly in order,
// so every chunk and every question about the audio waits its turn in one queue.

import { createLogger } from '../log.js';
import { pcmToFloat } from '../shared/pcm.js';
import { MAX_WAIT_MS } from '../speech/listener.js';
import { FRAME, Gate, SAMPLE_RATE, type Scorer } from './gate.js';
import type { Vad } from './models.js';
import { Framer, Resampler } from './resample.js';
import type { RingFrame, TimedScore } from './turns.js';

const log = createLogger('voice-gate');

const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;
// A delivered turn is read out of this much recent audio.
const RING_MS = 60_000;
// Scores are kept as long as a held turn can wait before it is delivered, and a little more.
const SCORES_MS = MAX_WAIT_MS + 30_000;
// Past this much audio waiting for the models, the oldest is dropped: the gate falls behind, the
// microphone never does.
const MAX_BACKLOG_MS = 5_000;
// A new press is not the same audio as the last one: silence this long resets the models' state.
const GAP_RESET_MS = 1_000;

export interface ClientStreamParams {
	client: string;
	createVad: () => Vad;
	now: () => number;
	isVoiceOsSpeaking: () => boolean;
}

type Job = { kind: 'frame'; frame: RingFrame } | { kind: 'task'; run: () => Promise<void> };

export class ClientStream {
	readonly ring: RingFrame[] = [];
	readonly scores: TimedScore[] = [];
	sampleRate = 0;
	// Made by the first chunk's reset, which every stream starts with.
	private vad: Vad | null = null;
	private resampler: Resampler | null = null;
	private framer = new Framer();
	private carry: number | null = null;
	private scorer: Scorer | null = null;
	private gate: Gate | null = null;
	private queue: Job[] = [];
	private isPumping = false;
	private lastChunkAt: number | null = null;
	private isClosed = false;

	constructor(private params: ClientStreamParams) {}

	get client(): string {
		return this.params.client;
	}

	// Called for every chunk the tab sends while its words go to speech-to-text; never throws.
	observe(chunk: Uint8Array, sampleRate: number): void {
		const at = this.params.now();
		const gap = this.lastChunkAt === null ? null : at - this.lastChunkAt;

		this.lastChunkAt = at;

		if (sampleRate !== this.sampleRate || (gap !== null && gap > GAP_RESET_MS)) {
			this.reset(sampleRate, gap);
		}

		const { samples, carry } = pcmToFloat(chunk, this.carry);

		this.carry = carry;

		const isVoiceOsSpeaking = this.params.isVoiceOsSpeaking();
		const resampled = (this.resampler as Resampler).push(samples);

		for (const samples16k of this.framer.push(resampled)) {
			this.queue.push({
				kind: 'frame',
				frame: { at, prob: 0, isVoiceOsSpeaking, samples: samples16k },
			});
		}

		this.dropBacklog();
		void this.pump();
	}

	// Scores every utterance from now on against the voiceprint behind this scorer.
	startScoring(scorer: Scorer): void {
		this.scorer = scorer;
		this.gate = new Gate(scorer);
	}

	// The voice was forgotten: nothing is scored until a new one is learned, a reset included.
	stopScoring(): void {
		this.scorer = null;
		this.gate = null;
		this.scores.length = 0;
	}

	// Runs once every frame observed so far has been through the models.
	after<T>(read: () => T | Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				kind: 'task',
				run: async () => {
					try {
						resolve(await read());
					} catch (error) {
						reject(error);
					}
				},
			});
			void this.pump();
		});
	}

	close(): void {
		this.isClosed = true;
		this.queue = this.queue.filter((job) => job.kind === 'task');
	}

	private reset(sampleRate: number, gap: number | null): void {
		if (this.sampleRate !== 0) {
			log.info('stream reset', { client: this.client, sampleRate, gapMs: gap });
		}

		this.sampleRate = sampleRate;
		this.resampler = new Resampler(sampleRate);
		this.framer = new Framer();
		this.carry = null;
		// Queued after the old stream's frames, so those finish with the state they started with.
		this.queue.push({
			kind: 'task',
			run: async () => {
				this.vad = this.params.createVad();
				this.gate = this.scorer ? new Gate(this.scorer) : null;
			},
		});
	}

	private dropBacklog(): void {
		const frames = this.queue.filter((job) => job.kind === 'frame').length;
		const excess = frames - Math.floor(MAX_BACKLOG_MS / FRAME_MS);

		if (excess <= 0) {
			return;
		}

		let dropped = 0;

		this.queue = this.queue.filter((job) => {
			if (job.kind === 'frame' && dropped < excess) {
				dropped += 1;

				return false;
			}

			return true;
		});
		log.warn('behind', { client: this.client, droppedFrames: dropped });
	}

	private async pump(): Promise<void> {
		if (this.isPumping) {
			return;
		}

		this.isPumping = true;

		try {
			for (let job = this.queue.shift(); job; job = this.queue.shift()) {
				await this.run(job);
			}
		} finally {
			this.isPumping = false;
		}
	}

	// A job that fails is logged and passed: the pump runs unawaited, and the next chunk must still flow.
	private async run(job: Job): Promise<void> {
		try {
			if (job.kind === 'task') {
				await job.run();
			} else if (!this.isClosed) {
				await this.hear(job.frame);
			}
		} catch (error) {
			log.warn('job failed', { client: this.client, kind: job.kind, error: String(error) });
		}
	}

	// For a read queued with after(): the press ended, so an utterance still undecided is scored now.
	async finishUtterance(): Promise<void> {
		const gate = this.gate;
		const at = this.ring.at(-1)?.at;

		if (!gate || at === undefined) {
			return;
		}

		await gate.finish();

		if (gate === this.gate) {
			this.collectScores(gate, at);
		}
	}

	private async hear(frame: RingFrame): Promise<void> {
		if (!this.vad) {
			return;
		}

		try {
			const heard = { ...frame, prob: await this.vad.prob(frame.samples) };

			this.remember(heard);
			await this.score(heard);
		} catch (error) {
			log.warn('frame not heard', { client: this.client, error: String(error) });
		}
	}

	private remember(frame: RingFrame): void {
		this.ring.push(frame);

		while ((this.ring[0]?.at ?? frame.at) < frame.at - RING_MS) {
			this.ring.shift();
		}
	}

	private async score(frame: RingFrame): Promise<void> {
		const gate = this.gate;

		if (!gate) {
			return;
		}

		// The forwarded frames are what real gating will send; a dry run only reads the scores.
		await gate.push(frame.samples, frame.prob);

		// Forgotten while this window was scored: its score belongs to a voice that is gone.
		if (gate === this.gate) {
			this.collectScores(gate, frame.at);
		}
	}

	private collectScores(gate: Gate, at: number): void {
		for (const score of gate.takeScores()) {
			const timed: TimedScore = {
				at,
				score: score.score,
				kind: score.kind,
				accepted: score.accepted,
			};

			this.scores.push(timed);
			log.info('score', {
				client: this.client,
				sampleRate: this.sampleRate,
				score: Math.round(score.score * 1000) / 1000,
				kind: score.kind,
				accepted: score.accepted,
			});
		}

		while ((this.scores[0]?.at ?? at) < at - SCORES_MS) {
			this.scores.shift();
		}
	}
}
