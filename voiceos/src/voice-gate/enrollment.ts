// Learning the developer's voice from speech that is provably theirs: 3 s chunks of it are embedded,
// and their mean becomes the voiceprint once enough of them agree.

export const CHUNK_SECONDS = 3;

export interface ChunkedSpeech {
	chunks: Float32Array[];
	// Under a chunk's length: carried into the next turn's speech.
	rest: Float32Array;
}

export const chunkSpeech = (pool: Float32Array, chunkSamples: number): ChunkedSpeech => {
	const count = Math.floor(pool.length / chunkSamples);
	const chunks = Array.from({ length: count }, (_, index) =>
		pool.slice(index * chunkSamples, (index + 1) * chunkSamples),
	);

	return { chunks, rest: pool.slice(count * chunkSamples) };
};

const norm = (vector: Float32Array): number => Math.hypot(...vector);

// A zero vector matches nothing, instead of turning every fit into NaN.
export const cosine = (left: Float32Array, right: Float32Array): number => {
	const lengths = norm(left) * norm(right);

	if (lengths === 0) {
		return 0;
	}

	let dot = 0;

	for (let index = 0; index < left.length; index++) {
		dot += (left[index] ?? 0) * (right[index] ?? 0);
	}

	return dot / lengths;
};

export const normalizedMean = (vectors: Float32Array[]): Float32Array => {
	const mean = new Float32Array(vectors[0]?.length ?? 0);

	for (const vector of vectors) {
		for (let index = 0; index < mean.length; index++) {
			mean[index] = (mean[index] ?? 0) + (vector[index] ?? 0) / vectors.length;
		}
	}

	const length = norm(mean);

	return length === 0 ? mean : mean.map((value) => value / length);
};

export interface LockInRule {
	// No voiceprint from less speech than this many chunks (10 × 3 s = 30 s).
	minChunks: number;
	// Only the latest chunks count, so a mixed start is outgrown instead of locked in.
	keep: number;
	// A chunk agrees when its similarity to the mean reaches this.
	fitAt: number;
	// This share of the chunks must agree.
	share: number;
}

export const LOCK_IN_RULE: LockInRule = { minChunks: 10, keep: 20, fitAt: 0.6, share: 0.8 };

export type LockIn =
	| { kind: 'locked'; voiceprint: Float32Array; fits: number[] }
	| { kind: 'collecting'; kept: Float32Array[]; fits: number[] };

export const decideLockIn = (
	embeddings: Float32Array[],
	rule: LockInRule = LOCK_IN_RULE,
): LockIn => {
	const kept = embeddings.slice(-rule.keep);

	if (kept.length < rule.minChunks) {
		return { kind: 'collecting', kept, fits: [] };
	}

	const voiceprint = normalizedMean(kept);
	const fits = kept.map((embedding) => cosine(embedding, voiceprint));
	const agreeing = fits.filter((fit) => fit >= rule.fitAt).length;

	return agreeing >= rule.share * kept.length
		? { kind: 'locked', voiceprint, fits }
		: { kind: 'collecting', kept, fits };
};
