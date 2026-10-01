// Opus for Discord, through opusscript's WebAssembly build (patched in patches/ to load its .wasm through
// a require, so a compiled Voice OS carries it). One encoder and one decoder, 48 kHz stereo.
import OpusScript from 'opusscript';
import { DISCORD_SAMPLE_RATE, FRAME_SAMPLES } from './audio.js';

export interface OpusCodec {
	encode: (stereoFrame: Uint8Array) => Uint8Array;
	decode: (packet: Uint8Array) => Uint8Array;
}

export const createOpusCodec = (): OpusCodec => {
	const encoder = new OpusScript(DISCORD_SAMPLE_RATE, 2, OpusScript.Application.VOIP);
	const decoder = new OpusScript(DISCORD_SAMPLE_RATE, 2);

	return {
		encode: (stereoFrame) =>
			new Uint8Array(encoder.encode(Buffer.from(stereoFrame), FRAME_SAMPLES)),
		decode: (packet) => new Uint8Array(decoder.decode(Buffer.from(packet))),
	};
};
