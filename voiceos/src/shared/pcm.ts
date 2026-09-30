// 16-bit little-endian PCM as floats: the page decodes Voice OS's speech with it, the server the mic.

export interface PcmChunk {
	samples: Float32Array;
	carry: number | null;
}

export const pcmToFloat = (bytes: Uint8Array, carry: number | null): PcmChunk => {
	// A chunk can end halfway through a sample; that byte carries into the next one.
	const joined = carry === null ? bytes : new Uint8Array([carry, ...bytes]);
	const count = Math.floor(joined.length / 2);
	const view = new DataView(joined.buffer, joined.byteOffset, count * 2);
	const samples = new Float32Array(count);

	for (let i = 0; i < count; i++) {
		samples[i] = view.getInt16(i * 2, true) / 32768;
	}

	return { samples, carry: joined.length % 2 === 1 ? (joined[joined.length - 1] ?? null) : null };
};
