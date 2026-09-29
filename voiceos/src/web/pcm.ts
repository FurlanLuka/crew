export const base64ToBytes = (base64: string): Uint8Array => {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}

	return bytes;
};

export type ChimeKind = 'plain' | 'needs';

const CHIME_NOTES: Record<
	ChimeKind,
	{ frequencyHz: number; startMs: number; durationMs: number }[]
> = {
	plain: [
		{ frequencyHz: 880, startMs: 0, durationMs: 160 },
		{ frequencyHz: 1318.5, startMs: 90, durationMs: 220 },
	],
	// A session that needs the developer: three rising notes, told apart from the plain two by ear.
	needs: [
		{ frequencyHz: 880, startMs: 0, durationMs: 140 },
		{ frequencyHz: 1108.7, startMs: 80, durationMs: 140 },
		{ frequencyHz: 1318.5, startMs: 160, durationMs: 220 },
	],
};
const CHIME_MS = 380;
const CHIME_GAIN = 0.18;

export const createChimeSamples = (sampleRate: number, kind: ChimeKind = 'plain'): Float32Array => {
	// Synthesized, not shipped as a file: nothing to fetch, and it plays at speech rate.
	const samples = new Float32Array(Math.round((sampleRate * CHIME_MS) / 1000));

	for (const note of CHIME_NOTES[kind]) {
		const startSample = Math.round((note.startMs / 1000) * sampleRate);
		const length = Math.round((note.durationMs / 1000) * sampleRate);

		for (let i = 0; i < length && startSample + i < samples.length; i++) {
			const seconds = i / sampleRate;
			// A few ms of attack against clicks, then a bell-like decay to silence.
			const envelope =
				Math.min(1, i / (0.004 * sampleRate)) * Math.exp((-5 * i) / length) * (1 - i / length);
			samples[startSample + i] =
				(samples[startSample + i] ?? 0) +
				CHIME_GAIN * envelope * Math.sin(2 * Math.PI * note.frequencyHz * seconds);
		}
	}

	return samples;
};
