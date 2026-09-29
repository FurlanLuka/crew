import { describe, expect, it } from 'bun:test';
import {
	adaptVoice,
	blend,
	countsAsDeveloper,
	decideAdaptation,
	isTrained,
	LEARNING_WEIGHT,
	rollingAverage,
	TRAINED_WEIGHT,
} from './adaptation.js';
import { cosine } from './enrollment.js';

const decide = (turnScore: number, source: 'push' | 'hands-free' | 'on-demand' = 'hands-free') =>
	decideAdaptation({ turnScore, enrolledScore: 0.9, source, isTrained: false });

describe('decideAdaptation', () => {
	it('a push turn → learned from 0.4 up; below it skipped, the held key notwithstanding', () => {
		expect(decide(0.39, 'push')).toEqual({ kind: 'skip', reason: 'not clearly the developer' });
		expect(decide(0.4, 'push')).toEqual({ kind: 'learn', weight: LEARNING_WEIGHT });
	});

	it('a listened turn (hands-free, on demand) → learned only from 0.6 up', () => {
		expect(decide(0.59).kind).toBe('skip');
		expect(decide(0.6).kind).toBe('learn');
		expect(decide(0.59, 'on-demand').kind).toBe('skip');
	});

	it('close to the voiceprint but far from whoever enrolled → skipped', () => {
		const at = (enrolledScore: number) =>
			decideAdaptation({ turnScore: 0.9, enrolledScore, source: 'push', isTrained: false });

		expect(at(0.49)).toEqual({ kind: 'skip', reason: 'far from enrollment' });
		expect(at(0.5).kind).toBe('learn');
	});

	it('trained → still learned, slower; never stopped', () => {
		const at = (trained: boolean) =>
			decideAdaptation({ turnScore: 0.9, enrolledScore: 0.9, source: 'push', isTrained: trained });

		expect(at(false)).toEqual({ kind: 'learn', weight: LEARNING_WEIGHT });
		expect(at(true)).toEqual({ kind: 'learn', weight: TRAINED_WEIGHT });
		expect(TRAINED_WEIGHT).toBeGreaterThan(0);
	});
});

describe('isTrained', () => {
	const ten = (score: number) => new Array(10).fill(score) as number[];

	it('the last 10 turns all at 0.6 or more, averaging 0.8 → trained', () => {
		expect(isTrained([0.6, 0.6, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9])).toBe(true);
		expect(isTrained(ten(0.8))).toBe(true);
	});

	it('fewer than 10 turns, however good → not yet', () => {
		expect(isTrained(ten(0.95).slice(1))).toBe(false);
	});

	it('one turn under 0.6 among the last 10 → not trained, whatever the average', () => {
		expect(isTrained([0.59, ...ten(0.95).slice(1)])).toBe(false);
	});

	it('all over 0.6 but averaging under 0.8 → not trained', () => {
		expect(isTrained(ten(0.79))).toBe(false);
	});

	it('an old weak turn out of the last 10 → no longer counts', () => {
		expect(isTrained([0.3, ...ten(0.85)])).toBe(true);
	});
});

describe('countsAsDeveloper', () => {
	it('a turn the gate would keep, near the enrollment → the developer’s, counted', () => {
		expect(countsAsDeveloper({ turnScore: 0.45, enrolledScore: 0.6 })).toBe(true);
	});

	it('a turn the gate would silence, or far from the enrollment → someone else, not counted', () => {
		expect(countsAsDeveloper({ turnScore: 0.39, enrolledScore: 0.9 })).toBe(false);
		expect(countsAsDeveloper({ turnScore: 0.9, enrolledScore: 0.49 })).toBe(false);
	});
});

describe('blend', () => {
	it('moves the voiceprint toward the turn by the weight, kept unit length', () => {
		const voiceprint = Float32Array.from([1, 0]);
		const turn = Float32Array.from([0, 1]);
		const blended = blend(voiceprint, turn, 0.2);

		expect(Math.hypot(...blended)).toBeCloseTo(1, 5);
		expect(cosine(blended, turn)).toBeGreaterThan(cosine(voiceprint, turn));
		expect(blended[1] ?? 0).toBeCloseTo(0.2 / Math.hypot(0.8, 0.2), 5);
	});
});

describe('rollingAverage', () => {
	it('nothing counted yet → null', () => {
		expect(rollingAverage([])).toBeNull();
	});

	it('only the last 10 count', () => {
		expect(rollingAverage([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])).toBe(1);
		expect(rollingAverage([0.5, 0.7])).toBeCloseTo(0.6);
	});
});

describe('adaptVoice', () => {
	const axis = (x: number, y: number, z = 0) => Float32Array.from([x, y, z]);
	const voice = (recentScores: number[] = []) => ({
		voiceprint: axis(1, 0),
		enrolled: axis(1, 0),
		recentScores,
		turns: recentScores.length,
	});

	it('someone else → the voice returned untouched', () => {
		const before = voice();
		const adapted = adaptVoice({
			voice: before,
			embeddings: [axis(0.3, 0, 0.954)],
			source: 'push',
		});

		expect(adapted.voice).toBe(before);
		expect(adapted.isDeveloper).toBe(false);
	});

	it('the developer, not clear enough to learn from → only its score counted', () => {
		const before = voice();
		const adapted = adaptVoice({
			voice: before,
			embeddings: [axis(0.55, 0, 0.835)],
			source: 'hands-free',
		});

		expect(adapted.voice.recentScores).toEqual([0.55]);
		expect(adapted.voice.voiceprint).toBe(before.voiceprint);
		expect(adapted.voice.turns).toBe(0);
	});

	it('clearly the developer → blended in by the learning weight, counted, one more turn', () => {
		const adapted = adaptVoice({ voice: voice(), embeddings: [axis(0.64, 0.768)], source: 'push' });

		expect(adapted.decision).toEqual({ kind: 'learn', weight: LEARNING_WEIGHT });
		expect(adapted.voice.voiceprint[1] ?? 0).toBeGreaterThan(0);
		expect(adapted.voice.recentScores).toEqual([0.64]);
		expect(adapted.voice.turns).toBe(1);
	});

	it('the 11th counted turn → only the last 10 scores kept', () => {
		const adapted = adaptVoice({
			voice: voice(new Array(10).fill(0.7)),
			embeddings: [axis(0.64, 0.768)],
			source: 'push',
		});

		expect(adapted.voice.recentScores).toHaveLength(10);
		expect(adapted.voice.recentScores.at(-1)).toBe(0.64);
	});

	it('a trained voice → learned from at the slow weight', () => {
		const adapted = adaptVoice({
			voice: voice(new Array(10).fill(0.85)),
			embeddings: [axis(0.9, 0.436)],
			source: 'push',
		});

		expect(adapted.decision).toEqual({ kind: 'learn', weight: TRAINED_WEIGHT });
	});
});
