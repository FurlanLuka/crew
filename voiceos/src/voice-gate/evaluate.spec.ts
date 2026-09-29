import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from './recorder.js';
import type { RingFrame } from './turns.js';
import {
	equalErrorRate,
	evaluate,
	operatingPoint,
	readRecordings,
	type Recording,
	replay,
	splitRecordings,
} from './evaluate.js';
import { cosine } from './enrollment.js';
import { FRAME, Gate } from './gate.js';
import type { Embed } from './models.js';

// A speaker model that also cares how much it heard: short audio from the developer points partly
// away, so a longer first window should score higher — the effect the tool is there to measure.
const lengthAwareEmbed: Embed = (audio) => {
	const vector = new Float32Array(3);
	const isDeveloper = Math.round((audio.at(-1) ?? 0) * 10) === 5;
	const reach = Math.min(1, audio.length / (3 * 16_000));

	if (isDeveloper) {
		vector[0] = reach;
		vector[1] = 1 - reach;
	} else {
		vector[2] = 1;
	}

	return Promise.resolve(vector);
};

const recordingOf = (
	name: string,
	label: 'turn' | 'other',
	at: number,
	level: number,
	speechFrames: number,
): Recording => {
	const count = speechFrames + 20;

	return {
		name,
		label,
		at,
		frames: Array.from({ length: count }, (_, index) =>
			new Float32Array(FRAME).fill(index < speechFrames ? level : 0.01),
		),
		probs: Array.from({ length: count }, (_, index) => (index < speechFrames ? 0.9 : 0)),
		voiceOsSpeaking: new Array(count).fill(false),
		turnCoverage: label === 'turn' ? 1 : 0,
		source: label === 'turn' ? 'listened' : null,
	};
};

const recordings = [
	...Array.from({ length: 6 }, (_, index) =>
		recordingOf(`you-${index}`, 'turn', 1_000 + index, 0.5, 200),
	),
	...Array.from({ length: 3 }, (_, index) =>
		recordingOf(`tv-${index}`, 'other', 5_000 + index, 0.3, 120),
	),
];

describe('splitRecordings', () => {
	it('by time: the earlier half of the developer’s turns learns, the later half is judged', () => {
		const shuffled = [...recordings].reverse();
		const { train, you, others } = splitRecordings(shuffled);

		expect(train.map((recording) => recording.name)).toEqual(['you-0', 'you-1', 'you-2']);
		expect(you.map((recording) => recording.name)).toEqual(['you-3', 'you-4', 'you-5']);
		expect(others).toHaveLength(3);
	});

	it('a turn recording mostly not covered by turns → left out of both', () => {
		const mixed = { ...recordingOf('mixed', 'turn', 9_999, 0.5, 100), turnCoverage: 0.3 };
		const { train, you } = splitRecordings([...recordings, mixed]);

		expect([...train, ...you].some((recording) => recording.name === 'mixed')).toBe(false);
	});
});

describe('replay', () => {
	it('the first decision → the same score the live gate takes, on the same frames', async () => {
		const voiceprint = Float32Array.from([1, 0, 0]);
		const recording = recordingOf('you', 'turn', 0, 0.5, 60);
		const live = new Gate(async (audio) => cosine(await lengthAwareEmbed(audio), voiceprint));

		for (const [index, frame] of recording.frames.entries()) {
			await live.push(frame, recording.probs[index] ?? 0);
		}

		const replayed = await replay(recording, voiceprint, {}, lengthAwareEmbed);

		expect(replayed.firstScore).toBeCloseTo(live.scores[0]?.score ?? -1, 5);
	});

	it('the developer → most of their speech kept (a weak start aside); another voice → none', async () => {
		const voiceprint = Float32Array.from([1, 0, 0]);

		expect(
			(await replay(recordingOf('you', 'turn', 0, 0.5, 200), voiceprint, {}, lengthAwareEmbed))
				.keptShare,
		).toBeGreaterThan(0.6);
		expect(
			(await replay(recordingOf('tv', 'other', 0, 0.3, 200), voiceprint, {}, lengthAwareEmbed))
				.keptShare,
		).toBe(0);
	});
});

describe('equalErrorRate', () => {
	it('perfectly apart → 0; fully overlapping → 0.5; nothing to compare → null', () => {
		expect(equalErrorRate([0.8, 0.9], [0.1, 0.2])?.rate).toBe(0);
		expect(equalErrorRate([0.5, 0.5], [0.5, 0.5])?.rate).toBe(0.5);
		expect(equalErrorRate([], [0.1])).toBeNull();
	});

	it('the threshold → one that splits the two, whatever scale the model scores on', () => {
		const split = equalErrorRate([0.93, 0.97], [0.62, 0.88]);

		expect(split?.threshold).toBeGreaterThan(0.88);
		expect(split?.threshold).toBeLessThanOrEqual(0.93);
	});
});

describe('evaluate', () => {
	it('every variant → counts of you and others, and a later first decision scores the developer higher', async () => {
		const results = await evaluate(recordings, lengthAwareEmbed);
		const today = results.find((result) => result.variant === 'today (3 s print)');
		const later = results.find((result) => result.variant === 'decide at 1.2 s');

		expect(results).toHaveLength(6);
		expect(results.every((result) => result.you.count === 3 && result.others.count === 3)).toBe(
			true,
		);
		expect(later?.you.median ?? 0).toBeGreaterThan(today?.you.median ?? 1);
		expect(today?.topOthers[0]?.name).toMatch(/^tv-/);
		expect(today?.threshold).toBe(0.4);
		expect(today?.atThresholds.map((row) => row.threshold)).toEqual([0.3, 0.35, 0.4, 0.45, 0.5]);
	});
});

describe('evaluate: what each measure says', () => {
	it('a recording whose only utterance is short and scored below the threshold → none of it kept', async () => {
		const voiceprint = Float32Array.from([0, 0, 1]);
		const short = recordingOf('short', 'turn', 0, 0.5, 15);

		expect((await replay(short, voiceprint, {}, lengthAwareEmbed)).keptShare).toBe(0);
	});

	it('shorter voiceprint pieces → a different voiceprint, so different scores (the variant is real)', async () => {
		const results = await evaluate(recordings, lengthAwareEmbed);
		const medianOf = (name: string) =>
			results.find((result) => result.variant === name)?.you.median;

		expect(medianOf('0.8 s print')).not.toBe(medianOf('today (3 s print)'));
	});

	it('threshold rows → the exact shares for known scores', async () => {
		const [today] = await evaluate(recordings, lengthAwareEmbed, {
			variants: [{ name: 'today', pieceSeconds: 3, gate: {} }],
		});
		const at40 = today?.atThresholds.find((row) => row.threshold === 0.4);
		const yourFirst = today?.you.median ?? 0;

		expect(at40?.youMissed).toBe(yourFirst < 0.4 ? 1 : 0);
		expect(at40?.othersLetIn).toBe(0);
		expect(today?.bySource.listened).toBe(yourFirst);
		expect(today?.bySource.push).toBeNull();
		expect(today?.rechecks.you ?? 0).toBeGreaterThan(yourFirst);
	});
});

describe('evaluate at a model’s own threshold', () => {
	it('a threshold → the gate replayed at it, and the rows centred on it', async () => {
		const [high] = await evaluate(recordings, lengthAwareEmbed, {
			variants: [{ name: 'today', pieceSeconds: 3, gate: {} }],
			threshold: 0.99,
		});

		expect(high?.threshold).toBe(0.99);
		expect(high?.atThresholds.map((row) => row.threshold)).toEqual([0.89, 0.94, 0.99, 1.04, 1.09]);
		// Nobody reaches 0.99 on this embed: the developer is silenced throughout.
		expect(high?.yourSpeechSilenced).toBe(1);
	});

	it('the operating point → between the developer’s first scores and everyone else’s', async () => {
		const [today] = await evaluate(recordings, lengthAwareEmbed, {
			variants: [{ name: 'today', pieceSeconds: 3, gate: {} }],
		});
		const point = await operatingPoint(recordings, lengthAwareEmbed);

		expect(point).toBe(Math.round((point ?? 0) * 100) / 100);
		expect(point).toBeGreaterThan(today?.others.p90 ?? 1);
		expect(point).toBeLessThanOrEqual(today?.you.p10 ?? 0);
	});

	it('no other voices recorded → no operating point', async () => {
		expect(
			await operatingPoint(
				recordings.filter((recording) => recording.label === 'turn'),
				lengthAwareEmbed,
			),
		).toBeNull();
	});
});

describe('readRecordings', () => {
	it('what the recorder saves → loads back: frames, probs aligned, the label and how it was said', () => {
		const dir = join(mkdtempSync(join(tmpdir(), 'eval-read-')), 'recordings');
		let clock = 1_000_000;
		const recorder = new Recorder({ dir, now: () => clock, waitMs: 10 });
		const frames: RingFrame[] = Array.from({ length: 5 }, (_, index) => ({
			at: clock + index * 32,
			prob: index / 10,
			isVoiceOsSpeaking: index === 4,
			samples: new Float32Array(FRAME).fill(0.25),
		}));

		recorder.add({ client: 'c1', sampleRate: 48_000, frames, scores: [], voiceprintTurns: 3 });
		recorder.markTurn({ client: 'c1', from: clock, to: clock + 100, source: 'push', text: 'go' });
		writeFileSync(join(dir, 'broken.json'), '{');
		clock += 1_000;
		recorder.tick();

		const skipped: string[] = [];
		const [loaded] = readRecordings(dir, (name) => skipped.push(name));

		expect(skipped).toEqual(['broken.json']);
		expect(loaded?.label).toBe('turn');
		expect(loaded?.source).toBe('push');
		expect(loaded?.frames).toHaveLength(5);
		expect(loaded?.probs).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
		expect(loaded?.voiceOsSpeaking).toEqual([false, false, false, false, true]);
		expect(loaded?.frames[0]?.[0]).toBeCloseTo(0.25, 3);
	});
});
