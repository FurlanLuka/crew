import { describe, expect, it } from 'bun:test';
import { base64ToBytes, createChimeSamples } from './pcm.js';

describe('base64ToBytes', () => {
	it('decodes', () => expect([...base64ToBytes('AQID')]).toEqual([1, 2, 3]));
});

describe('createChimeSamples', () => {
	it('a short, quiet sound that starts and ends silent (no click), then a gap before speech', () => {
		const samples = createChimeSamples(24_000);
		expect(samples.length).toBe(Math.round(24_000 * 0.38));
		const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
		expect(peak).toBeGreaterThan(0.05);
		expect(peak).toBeLessThan(0.3);
		expect(Math.abs(samples[0] ?? 1)).toBeLessThan(0.001);
		expect(samples.slice(-24 * 50).every((sample) => sample === 0)).toBe(true);
	});
});

describe('the needs-you chime', () => {
	it('is its own sound, as long as the plain one', () => {
		const plain = createChimeSamples(24_000);
		const needs = createChimeSamples(24_000, 'needs');

		expect(needs.length).toBe(plain.length);
		expect(needs.some((sample, index) => Math.abs(sample - (plain[index] ?? 0)) > 1e-3)).toBe(true);
	});
});
