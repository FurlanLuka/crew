// VOICEOS_RECORD_VOICE=1: what the mic heard, kept locally so other models and settings can be tried
// on the developer's real voice (scripts/voice-gate/eval-recordings.ts). Each speech segment waits
// until a turn could still claim it, then is saved as `turn` (it became a command) or `other`
// (nobody addressed Voice OS: a TV, people nearby, the developer talking to someone).

import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../log.js';
import type { ListenMode } from '../shared/protocol.js';
import { MAX_WAIT_MS } from '../speech/listener.js';
import { encodeWav } from '../speech/wav.js';
import { FRAME, SAMPLE_RATE } from './gate.js';
import { type RingFrame, type TimedScore, TURN_PAD_MS } from './turns.js';

const log = createLogger('voice-gate');

export type RecordingLabel = 'turn' | 'other';

export interface RecorderCaps {
	turn: number;
	other: number;
	bytes: number;
}

// Other voices would crowd out the developer's turns under one shared cap.
export const DEFAULT_CAPS: RecorderCaps = { turn: 400, other: 200, bytes: 300 * 1024 * 1024 };

// A segment waits this long for a turn to claim it: a held listened turn is delivered up to
// MAX_WAIT_MS after its words.
export const RECORDING_WAIT_MS = MAX_WAIT_MS + 10_000;
// The gate's rechecks for a segment's last frames land within a second or two of it closing: its
// scores are copied then, before the stream trims them.
const SCORES_SETTLE_MS = 5_000;
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;

export interface MarkedTurn {
	client: string;
	from: number;
	to: number;
	source: ListenMode;
	text: string;
}

export interface SegmentToRecord {
	client: string;
	sampleRate: number;
	frames: RingFrame[];
	scores: TimedScore[];
	voiceprintTurns: number | null;
}

interface Pending extends SegmentToRecord {
	closedAt: number;
	isScoresCopied: boolean;
}

interface Indexed {
	at: number;
	label: RecordingLabel;
	base: string;
	bytes: number;
}

export interface RecorderParams {
	dir: string;
	now: () => number;
	// How long a segment waits for a turn to claim it (a held listened turn can wait two minutes).
	waitMs: number;
	caps?: RecorderCaps;
}

const toInt16 = (frames: RingFrame[]): Int16Array => {
	const samples = new Int16Array(frames.length * FRAME);

	frames.forEach((frame, index) => {
		for (let at = 0; at < frame.samples.length; at++) {
			const clamped = Math.max(-1, Math.min(1, frame.samples[at] ?? 0));

			samples[index * FRAME + at] = Math.round(clamped * 32767);
		}
	});

	return samples;
};

// Whether a turn claims the segment: its start padded, since its first transcript lags its words.
const claims = (from: number, to: number, turn: MarkedTurn): boolean =>
	Math.min(to, turn.to) > Math.max(from, turn.from - TURN_PAD_MS);

// How much of [from, to] the turns cover, unpadded and overlaps counted once.
const coverageOf = (from: number, to: number, turns: MarkedTurn[]): number => {
	const spans = turns
		.map((turn) => [Math.max(from, turn.from), Math.min(to, turn.to)] as const)
		.filter(([start, end]) => end > start)
		.sort((left, right) => left[0] - right[0]);
	let covered = 0;
	let reached = from;

	for (const [start, end] of spans) {
		covered += Math.max(0, end - Math.max(start, reached));
		reached = Math.max(reached, end);
	}

	return Math.min(1, covered / Math.max(1, to - from));
};

// Every recording in the folder, indexed or not (a WAV whose JSON never got written included).
export const deleteRecordings = (dir: string): void => {
	let names: string[];

	try {
		names = readdirSync(dir);
	} catch {
		return;
	}

	let deleted = 0;
	let failed = 0;

	// One file that cannot be removed must not keep the rest.
	for (const name of names.filter((each) => each.endsWith('.wav') || each.endsWith('.json'))) {
		try {
			rmSync(join(dir, name), { force: true });
			deleted += 1;
		} catch {
			failed += 1;
		}
	}

	log.info('recordings deleted', { files: deleted, failed });
};

export class Recorder {
	private pending: Pending[] = [];
	private turns: MarkedTurn[] = [];
	private index: Indexed[] = [];
	private count = 0;
	private caps: RecorderCaps;

	constructor(private params: RecorderParams) {
		this.caps = params.caps ?? DEFAULT_CAPS;
		mkdirSync(params.dir, { recursive: true, mode: 0o700 });
		// mkdir leaves an existing folder's mode alone: other people's voices are in here.
		chmodSync(params.dir, 0o700);
		this.index = this.readIndex();
	}

	get files(): number {
		return this.index.length;
	}

	add(segment: SegmentToRecord): void {
		if (segment.frames.length > 0) {
			this.pending.push({ ...segment, closedAt: this.params.now(), isScoresCopied: false });
		}
	}

	markTurn(turn: MarkedTurn): void {
		this.turns.push(turn);
	}

	// Saves every segment no turn can claim any more. Runs from a timer: a disk error is logged here,
	// never thrown into the process.
	tick(): void {
		try {
			this.settle();
		} catch (error) {
			log.warn('recordings not saved', { error: String(error) });
		}
	}

	private settle(): void {
		const now = this.params.now();

		for (const segment of this.pending) {
			if (!segment.isScoresCopied && now - segment.closedAt >= SCORES_SETTLE_MS) {
				const from = segment.frames[0]?.at ?? 0;
				const to = (segment.frames.at(-1)?.at ?? from) + FRAME_MS;

				segment.scores = segment.scores.filter((score) => score.at >= from && score.at <= to);
				segment.isScoresCopied = true;
			}
		}

		const due = this.pending.filter((segment) => now - segment.closedAt >= this.params.waitMs);

		this.pending = this.pending.filter((segment) => now - segment.closedAt < this.params.waitMs);

		for (const segment of due) {
			this.save(segment);
		}

		// A turn this old can claim no segment still waiting.
		this.turns = this.turns.filter((turn) => turn.to >= now - 2 * this.params.waitMs);
	}

	// Forget my voice: the recordings go with it, and nothing waiting is saved after.
	deleteAll(): void {
		this.pending = [];
		this.turns = [];
		this.index = [];
		deleteRecordings(this.params.dir);
	}

	private save(segment: Pending): void {
		const from = segment.frames[0]?.at ?? 0;
		const to = (segment.frames.at(-1)?.at ?? from) + FRAME_MS;
		const claiming = this.turns.filter(
			(turn) => turn.client === segment.client && claims(from, to, turn),
		);
		const label: RecordingLabel = claiming.length > 0 ? 'turn' : 'other';
		const seconds = (segment.frames.length * FRAME) / SAMPLE_RATE;
		const turnCoverage = coverageOf(from, to, claiming);

		this.count += 1;

		const stamp = new Date(from).toISOString().replace(/[:.]/g, '-');
		const base = `${stamp}-${segment.client}-${this.count}-${label}`;
		const wav = encodeWav(toInt16(segment.frames), SAMPLE_RATE);
		const json = JSON.stringify({
			label,
			at: from,
			client: segment.client,
			// The WAV is 16 kHz; this is the rate the tab's mic sent at.
			micSampleRate: segment.sampleRate,
			seconds,
			turns: claiming.map((turn) => ({ source: turn.source, text: turn.text })),
			turnCoverage: Math.round(turnCoverage * 1000) / 1000,
			probs: segment.frames.map((frame) => Math.round(frame.prob * 1000) / 1000),
			voiceOsSpeaking: segment.frames.map((frame) => frame.isVoiceOsSpeaking),
			scores: segment.scores
				.filter((score) => score.at >= from && score.at <= to)
				.map((score) => ({ at: score.at, kind: score.kind, score: score.score })),
			voiceprintTurns: segment.voiceprintTurns,
		});

		try {
			// The WAV first: a recording without its JSON is ignored, never half-read.
			writeFileSync(join(this.params.dir, `${base}.wav`), wav, { mode: 0o600 });
			writeFileSync(join(this.params.dir, `${base}.json`), json, { mode: 0o600 });
		} catch (error) {
			log.warn('recording not saved', { client: segment.client, error: String(error) });

			try {
				rmSync(join(this.params.dir, `${base}.wav`), { force: true });
			} catch {
				// The folder sweep on forget still catches a WAV left behind.
			}

			return;
		}

		this.index.push({ at: from, label, base, bytes: wav.length + json.length });
		log.info('recorded', {
			client: segment.client,
			label,
			seconds: Math.round(seconds * 10) / 10,
			turnCoverage: Math.round(turnCoverage * 100) / 100,
		});
		this.enforceCaps();
	}

	private enforceCaps(): void {
		const removed: Indexed[] = [];
		const byAge = () => [...this.index].sort((left, right) => left.at - right.at);

		for (const label of ['turn', 'other'] as const) {
			const ofLabel = byAge().filter((entry) => entry.label === label);

			removed.push(...ofLabel.slice(0, Math.max(0, ofLabel.length - this.caps[label])));
		}

		let bytes = this.index.reduce((sum, entry) => sum + entry.bytes, 0);

		for (const entry of byAge()) {
			if (bytes <= this.caps.bytes) {
				break;
			}

			if (!removed.includes(entry)) {
				removed.push(entry);
			}

			bytes -= entry.bytes;
		}

		if (removed.length === 0) {
			return;
		}

		for (const entry of removed) {
			this.remove(entry);
		}

		this.index = this.index.filter((entry) => !removed.includes(entry));
		log.info('recordings capped', { removed: removed.length });
	}

	private remove(entry: Indexed): void {
		try {
			rmSync(join(this.params.dir, `${entry.base}.wav`), { force: true });
			rmSync(join(this.params.dir, `${entry.base}.json`), { force: true });
		} catch (error) {
			log.warn('recording not removed', { error: String(error) });
		}
	}

	// The recordings already there, from their JSON: a WAV without one is a half-written leftover.
	private readIndex(): Indexed[] {
		const entries: Indexed[] = [];

		for (const name of readdirSync(this.params.dir)) {
			if (!name.endsWith('.json')) {
				continue;
			}

			const base = name.slice(0, -'.json'.length);

			try {
				const meta = JSON.parse(readFileSync(join(this.params.dir, name), 'utf8')) as {
					at: number;
					label: RecordingLabel;
				};
				const bytes =
					statSync(join(this.params.dir, name)).size +
					statSync(join(this.params.dir, `${base}.wav`)).size;

				entries.push({ at: meta.at, label: meta.label, base, bytes });
			} catch {
				// Not one of ours, or damaged: left alone and not counted.
			}
		}

		return entries;
	}
}
