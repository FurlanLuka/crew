import { describe, expect, it } from 'bun:test';
import { FRAME } from './gate.js';
import { DEFAULT_SEGMENTER_CONFIG, Segmenter } from './segmenter.js';
import type { RingFrame } from './turns.js';

let at = 0;

const frame = (prob: number): RingFrame => {
	at += 32;

	return { at, prob, isVoiceOsSpeaking: false, samples: new Float32Array(FRAME) };
};

const feed = (segmenter: Segmenter, probs: [number, number][]): RingFrame[][] => {
	const out: RingFrame[][] = [];

	for (const [prob, count] of probs) {
		for (let index = 0; index < count; index++) {
			out.push(...segmenter.push(frame(prob)));
		}
	}

	return out;
};

const { padFrames, hangoverFrames, minSpeechFrames, maxFrames } = DEFAULT_SEGMENTER_CONFIG;

describe('Segmenter', () => {
	it('speech between quiet → one segment: padding before, speech, padding after', () => {
		const segments = feed(new Segmenter(), [
			[0, 40],
			[0.9, 30],
			[0, 40],
		]);

		expect(segments).toHaveLength(1);
		expect(segments[0]).toHaveLength(padFrames + 30 + padFrames);
	});

	it('probabilities between 0.35 and 0.5 → never open a segment, but keep an open one going', () => {
		expect(feed(new Segmenter(), [[0.4, 60]])).toEqual([]);

		const kept = feed(new Segmenter(), [
			[0.9, 20],
			[0.4, 30],
			[0, 40],
		]);

		expect(kept).toHaveLength(1);
		expect(kept[0]).toHaveLength(padFrames + 50 - padFrames + padFrames);
	});

	it('a pause shorter than the hangover → one segment, not two', () => {
		const segments = feed(new Segmenter(), [
			[0.9, 20],
			[0, hangoverFrames],
			[0.9, 20],
			[0, 40],
		]);

		expect(segments).toHaveLength(1);
	});

	it('exactly the minimum of speech → one segment', () => {
		expect(
			feed(new Segmenter(), [
				[0, 40],
				[0.9, minSpeechFrames],
				[0, 40],
			]),
		).toHaveLength(1);
	});

	it('less speech than the minimum (padding not counted) → no segment', () => {
		expect(
			feed(new Segmenter(), [
				[0, 40],
				[0.9, minSpeechFrames - 1],
				[0, 40],
			]),
		).toEqual([]);
	});

	it('speech from the very start → padding clipped, not invented', () => {
		const segments = feed(new Segmenter(), [
			[0.9, 30],
			[0, 40],
		]);

		expect(segments[0]).toHaveLength(30 + padFrames);
	});

	it('speech that never pauses → split at the maximum length', () => {
		const segments = feed(new Segmenter(), [[0.9, maxFrames * 2 + 10]]);

		expect(segments).toHaveLength(2);
		expect(segments.every((segment) => segment.length <= maxFrames)).toBe(true);
	});

	it('closed while speech is open (a reset, dropped audio, the tab gone) → emitted as it is', () => {
		const segmenter = new Segmenter();

		feed(segmenter, [
			[0, 20],
			[0.9, 30],
		]);

		const [closed] = segmenter.close();

		expect(closed).toHaveLength(padFrames + 30);
		expect(segmenter.close()).toEqual([]);
	});
});
