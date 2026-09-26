import { describe, expect, it } from 'bun:test';
import { addNoise, decodeWav, encodeWav, speedUp } from './wav.js';

describe('wav', () => {
	it('encode → decode round trip', () => {
		const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
		expect([...decodeWav(encodeWav(samples))]).toEqual([...samples]);
	});
	it('noise is deterministic for a seed and stays in range', () => {
		const loud = new Int16Array(100).fill(32000);
		expect([...addNoise(loud, 0.1, 3)]).toEqual([...addNoise(loud, 0.1, 3)]);
		expect(Math.max(...addNoise(loud, 0.5, 1))).toBeLessThanOrEqual(32767);
	});
	it('1.2x speed → 1/1.2 of the samples', () =>
		expect(speedUp(new Int16Array(1200), 1.2).length).toBe(1000));
	it('no data chunk → throws', () =>
		expect(() => decodeWav(new Uint8Array(44))).toThrow('no data chunk'));
});
