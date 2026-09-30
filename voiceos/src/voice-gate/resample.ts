// The mic's audio at the browser's rate, turned into the 16 kHz frames the models read. Only a copy
// is resampled: what Soniox gets stays at the native rate, since resampling cost it quality.

import { FRAME, SAMPLE_RATE } from './gate.js';

const joinSamples = (left: Float32Array, right: Float32Array): Float32Array => {
	const joined = new Float32Array(left.length + right.length);

	joined.set(left);
	joined.set(right, left.length);

	return joined;
};

// Each output sample averages the input samples it covers: enough of a low-pass for speech models,
// and chunk boundaries carry over so a stream split anywhere resamples the same as whole.
export class Resampler {
	private ratio: number;
	private pending: Float32Array = new Float32Array(0);
	// Counted from the stream's start, so a split never shifts where an output sample begins.
	private produced = 0;
	private dropped = 0;

	constructor(readonly inputRate: number) {
		this.ratio = inputRate / SAMPLE_RATE;
	}

	push(input: Float32Array): Float32Array {
		this.pending = joinSamples(this.pending, input);

		const out: number[] = [];
		const startOf = (index: number): number => Math.floor(index * this.ratio) - this.dropped;

		while (startOf(this.produced + 1) <= this.pending.length) {
			const start = startOf(this.produced);
			const end = Math.max(start + 1, startOf(this.produced + 1));
			let sum = 0;

			for (let index = start; index < end; index++) {
				sum += this.pending[index] ?? 0;
			}

			out.push(sum / (end - start));
			this.produced += 1;
		}

		const consumed = Math.max(0, startOf(this.produced));

		this.pending = this.pending.slice(consumed);
		this.dropped += consumed;

		return Float32Array.from(out);
	}
}

// Cuts a stream of samples into exact frames, carrying what is left into the next push.
export class Framer {
	private carry: Float32Array = new Float32Array(0);

	push(samples: Float32Array): Float32Array[] {
		const joined = joinSamples(this.carry, samples);
		const count = Math.floor(joined.length / FRAME);
		const frames = Array.from({ length: count }, (_, index) =>
			joined.slice(index * FRAME, (index + 1) * FRAME),
		);

		this.carry = joined.slice(count * FRAME);

		return frames;
	}
}
