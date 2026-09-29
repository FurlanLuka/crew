import { describe, expect, it } from 'bun:test';
import { FRAME } from './gate.js';
import { Framer, Resampler } from './resample.js';

const sine = (frequency: number, rate: number, seconds: number): Float32Array =>
	Float32Array.from({ length: Math.round(rate * seconds) }, (_, index) =>
		Math.sin((2 * Math.PI * frequency * index) / rate),
	);

// Zero crossings per second, halved: the dominant frequency of a clean sine.
const measureFrequency = (samples: Float32Array, rate: number): number => {
	let crossings = 0;

	for (let index = 1; index < samples.length; index++) {
		if ((samples[index - 1] ?? 0) < 0 !== (samples[index] ?? 0) < 0) {
			crossings += 1;
		}
	}

	return crossings / 2 / (samples.length / rate);
};

describe('Resampler', () => {
	for (const rate of [48_000, 44_100]) {
		it(`a 440 Hz sine at ${rate} Hz → 16 kHz, same length in time, same pitch`, () => {
			const out = new Resampler(rate).push(sine(440, rate, 1));

			expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1);
			expect(measureFrequency(out, 16_000)).toBeCloseTo(440, -1);
		});
	}

	it('16 kHz → passes through unchanged', () => {
		const input = sine(300, 16_000, 0.1);

		expect([...new Resampler(16_000).push(input)]).toEqual([...input]);
	});

	it('split at arbitrary points → the same output as whole', () => {
		const input = sine(440, 44_100, 0.5);
		const whole = new Resampler(44_100).push(input);
		const split = new Resampler(44_100);
		const parts: number[] = [];

		for (let at = 0, size = 1; at < input.length; at += size, size = (size * 7) % 997 || 1) {
			parts.push(...split.push(input.slice(at, at + size)));
		}

		expect(parts).toEqual([...whole]);
	});
});

describe('Framer', () => {
	it('1000 + 30 samples → two exact frames, 6 carried into the next', () => {
		const framer = new Framer();

		expect(framer.push(new Float32Array(1000))).toHaveLength(1);
		expect(framer.push(new Float32Array(30)).map((frame) => frame.length)).toEqual([FRAME]);
		expect(framer.push(new Float32Array(FRAME - 6))).toHaveLength(1);
	});
});
