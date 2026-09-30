import { describe, expect, it } from 'bun:test';
import { pcmToFloat } from './pcm.js';

const encodeLittleEndian = (...samples: number[]) => {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);

	for (const [index, sample] of samples.entries()) {
		view.setInt16(index * 2, sample, true);
	}

	return bytes;
};

describe('pcmToFloat', () => {
	it('little-endian int16 → floats; -32768 → -1, 32767 → just under 1', () => {
		const { samples, carry } = pcmToFloat(encodeLittleEndian(-32768, 0, 32767, 256), null);
		expect([...samples]).toEqual([-1, 0, 32767 / 32768, 256 / 32768]);
		expect(carry).toBeNull();
	});

	it('split at every offset, carry passed along → same samples as the whole buffer', () => {
		const whole = encodeLittleEndian(1, -2, 300, -4000, 32767, -32768, 7);
		const expected = [...pcmToFloat(whole, null).samples];

		for (let cut = 0; cut <= whole.length; cut++) {
			const first = pcmToFloat(whole.slice(0, cut), null);
			const second = pcmToFloat(whole.slice(cut), first.carry);
			expect([...first.samples, ...second.samples]).toEqual(expected);
			expect(second.carry).toBeNull();
		}
	});

	it('split into single bytes → still the same samples', () => {
		const whole = encodeLittleEndian(12345, -12345, 1);
		// Threads each byte's carry into the next call.
		let carry: number | null = null;
		const decoded: number[] = [];

		for (const byte of whole) {
			const chunk = pcmToFloat(new Uint8Array([byte]), carry);
			decoded.push(...chunk.samples);
			carry = chunk.carry;
		}

		expect(decoded).toEqual([...pcmToFloat(whole, null).samples]);
	});

	it('empty chunk → no samples, carry kept', () => {
		expect(pcmToFloat(new Uint8Array(), null)).toEqual({
			samples: new Float32Array(),
			carry: null,
		});
		expect(pcmToFloat(new Uint8Array(), 9)).toEqual({ samples: new Float32Array(), carry: 9 });
	});

	it('one byte → no samples, the byte carried', () =>
		expect(pcmToFloat(new Uint8Array([5]), null).carry).toBe(5));
});
