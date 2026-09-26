import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SaveDebugWavParams {
	dir: string;
	chunks: Uint8Array[];
	sampleRate: number;
	text: string;
}

type SavedDebugWav = {
	file: string;
	seconds: number;
};

const WAV_HEADER_BYTES = 44;

export const decodeWav = (bytes: Uint8Array): Int16Array => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// Walks the RIFF chunks one header at a time until the data chunk.
	let offset = 12;

	while (offset + 8 <= bytes.byteLength) {
		const chunkId = String.fromCharCode(...bytes.subarray(offset, offset + 4));
		const chunkSize = view.getUint32(offset + 4, true);

		if (chunkId === 'data') {
			const start = offset + 8;
			const end = Math.min(start + chunkSize, bytes.byteLength);

			return new Int16Array(bytes.slice(start, end - ((end - start) % 2)).buffer);
		}

		offset += 8 + chunkSize + (chunkSize % 2);
	}

	throw new Error('no data chunk in WAV');
};

export const encodeWav = (samples: Int16Array, sampleRate = 16000): Uint8Array => {
	const data = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
	const wav = new Uint8Array(WAV_HEADER_BYTES + data.byteLength);
	const view = new DataView(wav.buffer);

	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) {
			view.setUint8(offset + i, text.charCodeAt(i));
		}
	};

	writeAscii(0, 'RIFF');
	view.setUint32(4, 36 + data.byteLength, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(36, 'data');
	view.setUint32(40, data.byteLength, true);
	wav.set(data, WAV_HEADER_BYTES);

	return wav;
};

export const addNoise = (samples: Int16Array, amplitude: number, seed: number): Int16Array => {
	// Seeded generator state carried from one sample to the next, so the noise is deterministic.
	let state = seed;

	const nextRandom = () => {
		state = (state * 1664525 + 1013904223) >>> 0;

		return state / 0xffffffff - 0.5;
	};

	const noisy = new Int16Array(samples.length);

	for (let i = 0; i < samples.length; i++) {
		noisy[i] = Math.max(
			-32768,
			Math.min(32767, (samples[i] ?? 0) + Math.round(nextRandom() * 2 * amplitude * 32767)),
		);
	}

	return noisy;
};

export const speedUp = (samples: Int16Array, factor: number): Int16Array => {
	// Linear interpolation: faster speech, and a slightly higher pitch.
	const resampled = new Int16Array(Math.floor(samples.length / factor));

	for (let i = 0; i < resampled.length; i++) {
		const position = i * factor;
		const before = samples[Math.floor(position)] ?? 0;
		const after = samples[Math.min(Math.floor(position) + 1, samples.length - 1)] ?? 0;
		resampled[i] = Math.round(before + (after - before) * (position - Math.floor(position)));
	}

	return resampled;
};

export const saveDebugWav = ({
	dir,
	chunks,
	sampleRate,
	text,
}: SaveDebugWavParams): SavedDebugWav => {
	const bytes = Buffer.concat(chunks);
	const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
	mkdirSync(dir, { recursive: true });

	const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
	writeFileSync(file, encodeWav(samples, sampleRate));
	writeFileSync(file.replace(/\.wav$/, '.txt'), `${text}\n`);

	return { file, seconds: samples.length / sampleRate };
};
