import { describe, expect, it } from 'bun:test';
import { FRAME_SAMPLES, FrameSplitter, toDiscordStereo, toMono } from './audio.js';

const pcm = (...samples: number[]): Uint8Array => {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);

	for (const [index, sample] of samples.entries()) {
		view.setInt16(index * 2, sample, true);
	}

	return bytes;
};

const samplesOf = (bytes: Uint8Array): number[] => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	return Array.from({ length: bytes.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true));
};

describe('toMono', () => {
	it('stereo frames → the average of left and right', () =>
		expect(samplesOf(toMono(pcm(100, 300, -200, -400, 32_767, 32_767)))).toEqual([
			200, -300, 32_767,
		]));

	it('a trailing half frame is dropped', () =>
		expect(samplesOf(toMono(pcm(10, 20, 30)))).toEqual([15]));
});

describe('toDiscordStereo', () => {
	it('24 kHz → 48 kHz: each sample, then the midpoint to the next, on both channels', () =>
		expect(samplesOf(toDiscordStereo({ mono: pcm(0, 100, -100), sampleRate: 24_000 }))).toEqual([
			0, 0, 50, 50, 100, 100, 0, 0, -100, -100, -100, -100,
		]));

	it('a rate that does not divide 48 kHz → an error, not distorted audio', () =>
		expect(() => toDiscordStereo({ mono: pcm(1), sampleRate: 44_100 })).toThrow('44100'));
});

describe('FrameSplitter', () => {
	const frameBytes = FRAME_SAMPLES * 4;

	it('chunks across frame edges → whole 20 ms frames; the rest waits, then pads on flush', () => {
		const splitter = new FrameSplitter();
		const first = splitter.push(new Uint8Array(frameBytes + 10).fill(1));
		const second = splitter.push(new Uint8Array(frameBytes - 10).fill(2));
		const third = splitter.push(new Uint8Array(6).fill(3));
		const last = splitter.flush();

		expect(first.map((frame) => frame.byteLength)).toEqual([frameBytes]);
		expect(second).toHaveLength(1);
		expect(second[0]?.slice(0, 10)).toEqual(new Uint8Array(10).fill(1));
		expect(third).toEqual([]);
		expect(last).toHaveLength(1);
		expect(last[0]?.slice(0, 7)).toEqual(new Uint8Array([3, 3, 3, 3, 3, 3, 0]));
		expect(splitter.flush()).toEqual([]);
	});
});
