import { describe, expect, it } from 'bun:test';
import { FRAME_SAMPLES } from './audio.js';
import { createOpusCodec } from './codec.js';

describe('createOpusCodec', () => {
	it('a 20 ms stereo frame → a small packet → 20 ms of stereo again', () => {
		const codec = createOpusCodec();
		const frame = new Uint8Array(FRAME_SAMPLES * 4);
		const view = new DataView(frame.buffer);

		for (let index = 0; index < FRAME_SAMPLES; index++) {
			const sample = Math.round(Math.sin(index / 10) * 8000);
			view.setInt16(index * 4, sample, true);
			view.setInt16(index * 4 + 2, sample, true);
		}

		const packet = codec.encode(frame);

		expect(packet.byteLength).toBeGreaterThan(0);
		expect(packet.byteLength).toBeLessThan(frame.byteLength / 4);
		expect(codec.decode(packet).byteLength).toBe(frame.byteLength);
	});
});
