// Discord speaks 48 kHz stereo 16-bit PCM in 20 ms Opus frames; Voice OS hears mono and speaks mono at
// SPEECH_SAMPLE_RATE. These convert between the two and nothing else.

export const DISCORD_SAMPLE_RATE = 48_000;
// One Opus frame: 20 ms at 48 kHz.
export const FRAME_SAMPLES = 960;
const STEREO_FRAME_BYTES = FRAME_SAMPLES * 2 * 2;

// What Discord sends the developer's voice as, folded to one channel for speech-to-text.
export const toMono = (stereo: Uint8Array): Uint8Array => {
	const input = new DataView(stereo.buffer, stereo.byteOffset, stereo.byteLength);
	const frames = Math.floor(stereo.byteLength / 4);
	const mono = new Uint8Array(frames * 2);
	const output = new DataView(mono.buffer);

	for (let frame = 0; frame < frames; frame++) {
		const left = input.getInt16(frame * 4, true);
		const right = input.getInt16(frame * 4 + 2, true);
		output.setInt16(frame * 2, Math.round((left + right) / 2), true);
	}

	return mono;
};

interface ToDiscordParams {
	mono: Uint8Array;
	sampleRate: number;
}

// Voice OS's speech, raised to Discord's rate and copied to both channels. The rate is a whole multiple
// (24 kHz → 48 kHz): each sample is followed by the midpoint to the next, so the line is not stepped.
export const toDiscordStereo = ({ mono, sampleRate }: ToDiscordParams): Uint8Array => {
	const factor = DISCORD_SAMPLE_RATE / sampleRate;

	if (!Number.isInteger(factor) || factor < 1) {
		throw new Error(`speech rate ${sampleRate} does not divide ${DISCORD_SAMPLE_RATE}`);
	}

	const input = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
	const samples = Math.floor(mono.byteLength / 2);
	const stereo = new Uint8Array(samples * factor * 4);
	const output = new DataView(stereo.buffer);

	for (let index = 0; index < samples; index++) {
		const current = input.getInt16(index * 2, true);
		const next = index + 1 < samples ? input.getInt16((index + 1) * 2, true) : current;

		for (let step = 0; step < factor; step++) {
			const value = Math.round(current + ((next - current) * step) / factor);
			const at = (index * factor + step) * 4;
			output.setInt16(at, value, true);
			output.setInt16(at + 2, value, true);
		}
	}

	return stereo;
};

// Cuts stereo PCM into whole 20 ms frames; what is left over waits for the next chunk.
export class FrameSplitter {
	private rest = new Uint8Array(0);

	push(chunk: Uint8Array): Uint8Array[] {
		const joined = new Uint8Array(this.rest.byteLength + chunk.byteLength);
		joined.set(this.rest);
		joined.set(chunk, this.rest.byteLength);
		const count = Math.floor(joined.byteLength / STEREO_FRAME_BYTES);
		const frames = Array.from({ length: count }, (_, index) =>
			joined.slice(index * STEREO_FRAME_BYTES, (index + 1) * STEREO_FRAME_BYTES),
		);

		this.rest = joined.slice(count * STEREO_FRAME_BYTES);

		return frames;
	}

	// The clip's end: the last part frame is padded with silence so nothing is cut.
	flush(): Uint8Array[] {
		if (this.rest.byteLength === 0) {
			return [];
		}

		const frame = new Uint8Array(STEREO_FRAME_BYTES);
		frame.set(this.rest);
		this.rest = new Uint8Array(0);

		return [frame];
	}
}
