import { describe, expect, it } from 'bun:test';
import { chunkSpeech, cosine, decideLockIn } from './enrollment.js';

const DIMENSIONS = 8;

// A speaker's chunk: mostly their own axis, a little of the next, so chunks are close, not identical.
const chunkOf = (speaker: number, wobble = 0): Float32Array => {
	const vector = new Float32Array(DIMENSIONS);

	vector[speaker] = 1;
	vector[(speaker + 1) % DIMENSIONS] = wobble;

	return vector;
};

const chunksOf = (speaker: number, count: number): Float32Array[] =>
	Array.from({ length: count }, (_, index) => chunkOf(speaker, (index % 3) * 0.1));

describe('chunkSpeech', () => {
	it('7 s at 16 kHz in 3 s chunks → 2 chunks, 1 s carried', () => {
		const { chunks, rest } = chunkSpeech(new Float32Array(7 * 16_000), 3 * 16_000);

		expect(chunks.map((chunk) => chunk.length)).toEqual([48_000, 48_000]);
		expect(rest.length).toBe(16_000);
	});

	it('2 s → no chunk, all of it carried', () => {
		const { chunks, rest } = chunkSpeech(new Float32Array(2 * 16_000), 3 * 16_000);

		expect(chunks).toEqual([]);
		expect(rest.length).toBe(32_000);
	});

	it('1.5 s carried + 1.5 s of the next turn → one chunk, in order', () => {
		const first = chunkSpeech(new Float32Array(24_000).fill(1), 48_000);
		const pool = new Float32Array(48_000);

		pool.set(first.rest);
		pool.set(new Float32Array(24_000).fill(2), first.rest.length);

		const second = chunkSpeech(pool, 48_000);

		expect(second.chunks).toHaveLength(1);
		expect([second.chunks[0]?.[0], second.chunks[0]?.[47_999]]).toEqual([1, 2]);
		expect(second.rest.length).toBe(0);
	});
});

describe('cosine', () => {
	it('same direction → 1, orthogonal → 0', () => {
		expect(cosine(chunkOf(0), chunkOf(0))).toBeCloseTo(1);
		expect(cosine(chunkOf(0), chunkOf(3))).toBe(0);
	});

	it('a zero vector → 0, not NaN', () => {
		expect(cosine(new Float32Array(DIMENSIONS), chunkOf(0))).toBe(0);
	});
});

describe('decideLockIn', () => {
	it('10 agreeing chunks → locked on their voice', () => {
		const decision = decideLockIn(chunksOf(0, 10));

		expect(decision.kind).toBe('locked');

		if (decision.kind === 'locked') {
			expect(cosine(decision.voiceprint, chunkOf(0))).toBeGreaterThan(0.99);
			expect(decision.fits).toHaveLength(10);
		}
	});

	it('9 chunks → still collecting', () => {
		expect(decideLockIn(chunksOf(0, 9)).kind).toBe('collecting');
	});

	it('8 of 10 agreeing → locked; 7 of 10 → collecting', () => {
		const withOthers = (own: number) => [
			...chunksOf(0, own),
			...Array.from({ length: 10 - own }, (_, index) => chunkOf(2 + index)),
		];

		expect(decideLockIn(withOthers(8)).kind).toBe('locked');
		expect(decideLockIn(withOthers(7)).kind).toBe('collecting');
	});

	it('a fit of exactly the bar counts as agreeing', () => {
		const chunks = chunksOf(0, 10);
		const lowestFit = Math.min(...decideLockIn(chunks).fits);
		const rule = { minChunks: 10, keep: 20, share: 1 };

		expect(decideLockIn(chunks, { ...rule, fitAt: lowestFit }).kind).toBe('locked');
		expect(decideLockIn(chunks, { ...rule, fitAt: lowestFit + 1e-6 }).kind).toBe('collecting');
	});

	it('three speakers mixed, none holding the share → collecting', () => {
		const decision = decideLockIn([...chunksOf(0, 4), ...chunksOf(2, 3), ...chunksOf(4, 3)]);

		expect(decision.kind).toBe('collecting');
	});

	it('25 disagreeing chunks → only the latest 20 kept', () => {
		const chunks = Array.from({ length: 25 }, (_, index) => chunkOf(index % DIMENSIONS));
		const decision = decideLockIn(chunks);

		expect(decision.kind).toBe('collecting');

		if (decision.kind === 'collecting') {
			expect(decision.kept).toHaveLength(20);
			expect(decision.kept[0]).toBe(chunks[5] as Float32Array);
		}
	});

	it('other voices first, then enough of the developer → locked on the developer', () => {
		const others = Array.from({ length: 10 }, (_, index) => chunkOf(1 + (index % 6)));
		const decision = decideLockIn([...others, ...chunksOf(0, 20)]);

		expect(decision.kind).toBe('locked');

		if (decision.kind === 'locked') {
			expect(cosine(decision.voiceprint, chunkOf(0))).toBeGreaterThan(0.99);
		}
	});
});
