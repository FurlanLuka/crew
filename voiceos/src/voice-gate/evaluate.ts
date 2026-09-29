// The recordings replayed through the gate offline, one variant at a time: which voiceprint and
// which decision rule tell the developer from everyone else best, on their real voice. The scoring
// is pure over an injected `embed`, so any speaker model can be compared the same way;
// `readRecordings` is the one read from disk.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from '../speech/wav.js';
import { chunkSpeech, cosine, normalizedMean } from './enrollment.js';
import { DEFAULT_GATE_CONFIG, FRAME, Gate, type GateConfig, SAMPLE_RATE } from './gate.js';
import type { Embed } from './models.js';

export interface Recording {
	name: string;
	label: 'turn' | 'other';
	at: number;
	frames: Float32Array[];
	probs: number[];
	voiceOsSpeaking: boolean[];
	turnCoverage: number;
	source: 'push' | 'listened' | null;
}

export interface Variant {
	name: string;
	// The length of the pieces the voiceprint is averaged from.
	pieceSeconds: number;
	gate: Partial<GateConfig>;
}

interface RecordingMeta {
	label: 'turn' | 'other';
	at: number;
	probs: number[];
	voiceOsSpeaking: boolean[];
	turnCoverage: number;
	turns: { source: string }[];
}

// The recorder's files back as recordings. A damaged file, or a JSON whose WAV is gone, is skipped
// (said through onSkip) rather than ending the run.
export const readRecordings = (
	dir: string,
	onSkip: (name: string, error: unknown) => void = () => undefined,
): Recording[] =>
	readdirSync(dir)
		.filter((name) => name.endsWith('.json'))
		.flatMap((name) => {
			const base = name.slice(0, -'.json'.length);

			try {
				const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RecordingMeta;
				const samples = decodeWav(new Uint8Array(readFileSync(join(dir, `${base}.wav`))));
				const frames = Array.from({ length: Math.floor(samples.length / FRAME) }, (_, index) =>
					Float32Array.from(
						samples.subarray(index * FRAME, (index + 1) * FRAME),
						(sample) => sample / 32768,
					),
				);
				const source = meta.turns[0]?.source;

				return [
					{
						name: base,
						label: meta.label,
						at: meta.at,
						frames,
						probs: meta.probs,
						voiceOsSpeaking: meta.voiceOsSpeaking,
						turnCoverage: meta.turnCoverage,
						source: source === undefined ? null : source === 'push' ? 'push' : 'listened',
					} satisfies Recording,
				];
			} catch (error) {
				onSkip(name, error);

				return [];
			}
		});

export const VARIANTS: Variant[] = [
	{ name: 'today (3 s print)', pieceSeconds: 3, gate: {} },
	{ name: '1.5 s print', pieceSeconds: 1.5, gate: {} },
	{ name: '0.8 s print', pieceSeconds: 0.8, gate: {} },
	{ name: 'median of 3', pieceSeconds: 3, gate: { flipMedianOf: 3 } },
	{ name: 'growing to 3 s', pieceSeconds: 3, gate: { windowFrames: 94 } },
	{ name: 'decide at 1.2 s', pieceSeconds: 3, gate: { decideFrames: 38 } },
];

// Around the threshold a model is judged at: each speaker model scores on its own scale (WavLM puts
// other voices where ECAPA puts the developer), so fixed values would only fit one of them.
export const THRESHOLD_OFFSETS = [-0.1, -0.05, 0, 0.05, 0.1];

// A turn recording counts as the developer's only when turns cover most of it.
const MIN_COVERAGE = 0.8;
const SPEECH_ON = DEFAULT_GATE_CONFIG.speechOn;

export interface Split {
	train: Recording[];
	you: Recording[];
	others: Recording[];
}

// By time, not by name: the voiceprint is learned from the earlier half of the developer's turns
// and judged on the later half, as it would be live.
export const splitRecordings = (recordings: Recording[]): Split => {
	const yours = recordings
		.filter((recording) => recording.label === 'turn' && recording.turnCoverage >= MIN_COVERAGE)
		.sort((left, right) => left.at - right.at);
	const half = Math.ceil(yours.length / 2);

	return {
		train: yours.slice(0, half),
		you: yours.slice(half),
		others: recordings.filter((recording) => recording.label === 'other'),
	};
};

const speechOf = (recording: Recording): Float32Array => {
	const kept = recording.frames.filter(
		(_, index) => (recording.probs[index] ?? 0) >= SPEECH_ON && !recording.voiceOsSpeaking[index],
	);
	const audio = new Float32Array(kept.length * FRAME);

	kept.forEach((frame, index) => {
		audio.set(frame, index * FRAME);
	});

	return audio;
};

// As live learning does: the speech of every turn pooled, then cut into pieces, so short turns add up.
export const buildVoiceprint = async (
	recordings: Recording[],
	pieceSeconds: number,
	embed: Embed,
): Promise<Float32Array> => {
	const speech = recordings.map(speechOf);
	const pool = new Float32Array(speech.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;

	for (const part of speech) {
		pool.set(part, offset);
		offset += part.length;
	}

	const embeddings: Float32Array[] = [];

	for (const piece of chunkSpeech(pool, Math.round(pieceSeconds * SAMPLE_RATE)).chunks) {
		embeddings.push(await embed(piece));
	}

	return normalizedMean(embeddings);
};

export interface Replay {
	firstScore: number | null;
	rechecks: number[];
	// The share of the recording's speech frames the gate would have let through.
	keptShare: number;
}

// One recording through the real gate, as the live stream would feed it.
export const replay = async (
	recording: Recording,
	voiceprint: Float32Array,
	config: Partial<GateConfig>,
	embed: Embed,
): Promise<Replay> => {
	const gate = new Gate(async (audio) => cosine(await embed(audio), voiceprint), config);
	const pushed: Float32Array[] = [];
	let kept = 0;
	let speech = 0;
	let answered = 0;

	const collect = (out: Float32Array[]) => {
		for (const frame of out) {
			const index = answered++;

			if ((recording.probs[index] ?? 0) >= SPEECH_ON) {
				speech += 1;
				kept += frame === pushed[index] ? 1 : 0;
			}
		}
	};

	for (const [index, frame] of recording.frames.entries()) {
		pushed.push(frame);
		collect(await gate.push(frame, recording.probs[index] ?? 0));
	}

	// The recording ends in quiet, long enough for the gate's own pause to decide what is still open.
	for (
		let quiet = 0;
		quiet <= (config.hangoverFrames ?? DEFAULT_GATE_CONFIG.hangoverFrames);
		quiet++
	) {
		const frame = new Float32Array(FRAME);

		pushed.push(frame);
		collect(await gate.push(frame, 0));
	}

	return {
		firstScore: gate.scores.find((score) => score.kind === 'first')?.score ?? null,
		rechecks: gate.scores.filter((score) => score.kind === 'recheck').map((score) => score.score),
		keptShare: speech === 0 ? 1 : kept / speech,
	};
};

const quantile = (values: number[], share: number): number | null => {
	const sorted = [...values].sort((left, right) => left - right);

	return sorted.length === 0 ? null : (sorted[Math.floor((sorted.length - 1) * share)] ?? null);
};

export interface EqualError {
	rate: number;
	threshold: number;
}

// The threshold where turning the developer away is as likely as letting another voice in, and how
// often either happens there.
export const equalErrorRate = (you: number[], others: number[]): EqualError | null => {
	if (you.length === 0 || others.length === 0) {
		return null;
	}

	let best = { gap: Number.POSITIVE_INFINITY, rate: 0, threshold: 0 };

	for (const threshold of [...you, ...others]) {
		const miss = you.filter((score) => score < threshold).length / you.length;
		const accept = others.filter((score) => score >= threshold).length / others.length;
		const gap = Math.abs(miss - accept);

		if (gap < best.gap) {
			best = { gap, rate: (miss + accept) / 2, threshold };
		}
	}

	return { rate: best.rate, threshold: best.threshold };
};

export interface VariantResult {
	variant: string;
	// What the gate replay and the rows below were judged at.
	threshold: number;
	you: { count: number; p10: number | null; median: number | null };
	others: { count: number; median: number | null; p90: number | null };
	// Per threshold: the share of the developer's utterances that would start silenced, and of other
	// voices' that would start let through.
	atThresholds: { threshold: number; youMissed: number; othersLetIn: number }[];
	eer: EqualError | null;
	// Later windows, steadier than the first: medians for you and for others.
	rechecks: { you: number | null; others: number | null };
	// Your first-decision median by how you spoke: a held key, or listened.
	bySource: { push: number | null; listened: number | null };
	// At the threshold: how much of the developer's speech the gate would silence.
	yourSpeechSilenced: number;
	topOthers: { name: string; score: number }[];
}

const firstsFrom = (
	recordings: Recording[],
	replays: Replay[],
	source: Recording['source'],
): number[] =>
	recordings.flatMap((recording, index) => {
		const first = replays[index]?.firstScore;

		return recording.source === source && first !== null && first !== undefined ? [first] : [];
	});

export interface EvaluateOptions {
	variants?: Variant[];
	threshold?: number;
}

export const evaluate = async (
	recordings: Recording[],
	embed: Embed,
	{ variants = VARIANTS, threshold = DEFAULT_GATE_CONFIG.threshold }: EvaluateOptions = {},
): Promise<VariantResult[]> => {
	const { train, you, others } = splitRecordings(recordings);
	const results: VariantResult[] = [];

	for (const variant of variants) {
		const voiceprint = await buildVoiceprint(train, variant.pieceSeconds, embed);
		const config = { ...DEFAULT_GATE_CONFIG, ...variant.gate, threshold };
		const yours = await Promise.all(
			you.map((recording) => replay(recording, voiceprint, config, embed)),
		);
		const theirs = await Promise.all(
			others.map((recording) => replay(recording, voiceprint, config, embed)),
		);
		const yourFirsts = yours.flatMap((result) =>
			result.firstScore === null ? [] : [result.firstScore],
		);
		const theirFirsts = theirs.flatMap((result) =>
			result.firstScore === null ? [] : [result.firstScore],
		);
		const share = (values: number[], test: (value: number) => boolean) =>
			values.length === 0 ? 0 : values.filter(test).length / values.length;

		results.push({
			variant: variant.name,
			threshold,
			you: {
				count: yourFirsts.length,
				p10: quantile(yourFirsts, 0.1),
				median: quantile(yourFirsts, 0.5),
			},
			others: {
				count: theirFirsts.length,
				median: quantile(theirFirsts, 0.5),
				p90: quantile(theirFirsts, 0.9),
			},
			atThresholds: THRESHOLD_OFFSETS.map((offset) => {
				const at = Math.round((threshold + offset) * 100) / 100;

				return {
					threshold: at,
					youMissed: share(yourFirsts, (score) => score < at),
					othersLetIn: share(theirFirsts, (score) => score >= at),
				};
			}),
			eer: equalErrorRate(yourFirsts, theirFirsts),
			rechecks: {
				you: quantile(
					yours.flatMap((result) => result.rechecks),
					0.5,
				),
				others: quantile(
					theirs.flatMap((result) => result.rechecks),
					0.5,
				),
			},
			bySource: {
				push: quantile(firstsFrom(you, yours, 'push'), 0.5),
				listened: quantile(firstsFrom(you, yours, 'listened'), 0.5),
			},
			yourSpeechSilenced:
				yours.length === 0
					? 0
					: 1 - yours.reduce((sum, result) => sum + result.keptShare, 0) / yours.length,
			topOthers: others
				.map((recording, index) => ({
					name: recording.name,
					score: theirs[index]?.firstScore ?? 0,
				}))
				.sort((left, right) => right.score - left.score)
				.slice(0, 10),
		});
	}

	return results;
};

// A model's operating point: where its first decisions under today's rule split the developer from
// everyone else best. Picked on the same recordings it is then judged on, so it ranks models fairly
// but is not a threshold to run live.
export const operatingPoint = async (
	recordings: Recording[],
	embed: Embed,
): Promise<number | null> => {
	const [today] = await evaluate(recordings, embed, { variants: VARIANTS.slice(0, 1) });

	const threshold = today?.eer?.threshold;

	// Rounded once, so the replay, the rows and what is printed share one value.
	return threshold === undefined ? null : Math.round(threshold * 100) / 100;
};
