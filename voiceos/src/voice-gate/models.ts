// The only file that touches onnxruntime. Silero VAD says which frames are speech; ECAPA-TDNN (its
// Fbank front end exported with it) turns speech into a speaker embedding. Nothing here is imported
// until the pack is on disk, so a machine without it, and CI, never load the native runtime.

import { dlopen } from 'bun:ffi';
import { join } from 'node:path';
import type * as Ort from 'onnxruntime-node';
import { FRAME, SAMPLE_RATE } from './gate.js';

// Silero v5 reads each frame with the 64 samples before it; its Python wrapper prepends them.
export const VAD_CONTEXT = 64;

export interface FrameWithContext {
	input: Float32Array;
	tail: Float32Array;
}

export const withContext = (tail: Float32Array, frame: Float32Array): FrameWithContext => {
	const input = new Float32Array(VAD_CONTEXT + frame.length);

	input.set(tail);
	input.set(frame, VAD_CONTEXT);

	return { input, tail: frame.slice(-VAD_CONTEXT) };
};

// One stream's view of the VAD: its recurrent state and context are its own.
export interface Vad {
	prob: (frame: Float32Array) => Promise<number>;
}

// An L2-normalized speaker embedding.
export type Embed = (audio: Float32Array) => Promise<Float32Array>;

export interface Models {
	createVad: () => Vad;
	embed: Embed;
}

export const PACK_FILES = {
	vad: 'silero_vad.onnx',
	ecapa: 'ecapa.onnx',
	// The ECAPA weights, stored beside the graph by the exporter.
	ecapaData: 'ecapa.onnx.data',
} as const;

export const runtimeLibraryName = (platform: NodeJS.Platform): string =>
	platform === 'darwin' ? 'libonnxruntime.1.dylib' : 'libonnxruntime.so.1';

const SESSION_OPTIONS: Ort.InferenceSession.SessionOptions = {
	// One thread each: the models run once a second at most, and the machine's cores belong to the
	// Claude sessions.
	intraOpNumThreads: 1,
	interOpNumThreads: 1,
	executionMode: 'sequential',
};

// Held for the process's life: a closed handle would unload the library under the addon.
let runtimeLibrary: { close: () => void } | null = null;

const loadRuntime = async (packDir: string): Promise<typeof Ort> => {
	// The addon links the library by @rpath (macOS) or $ORIGIN (Linux), which a compiled binary cannot
	// satisfy; one already loaded under the same name is reused instead of searched for.
	if (!runtimeLibrary) {
		runtimeLibrary = dlopen(join(packDir, runtimeLibraryName(process.platform)), {
			OrtGetApiBase: { args: [], returns: 'ptr' },
		});
	}

	return import('onnxruntime-node');
};

// Every speaker model keeps ECAPA's contract: `wav` [1, samples] of raw 16 kHz audio in, `embedding`
// out, L2-normalized.
const embedFrom =
	(ort: typeof Ort, session: Ort.InferenceSession): Embed =>
	async (audio) => {
		const out = await session.run({ wav: new ort.Tensor('float32', audio, [1, audio.length]) });

		return Float32Array.from((out.embedding as Ort.Tensor).data as Float32Array);
	};

// Any speaker model on the pack's runtime: ECAPA, and the offline comparison's candidates.
export const loadEmbedModel = async (packDir: string, modelPath: string): Promise<Embed> => {
	const ort = await loadRuntime(packDir);
	const session = await ort.InferenceSession.create(modelPath, SESSION_OPTIONS);

	if (session.inputNames.join() !== 'wav' || session.outputNames.join() !== 'embedding') {
		throw new Error(
			`${modelPath} takes ${session.inputNames.join()} and gives ${session.outputNames.join()}, not wav → embedding`,
		);
	}

	return embedFrom(ort, session);
};

export const loadModels = async (packDir: string): Promise<Models> => {
	const ort = await loadRuntime(packDir);
	const [vadSession, embed] = await Promise.all([
		ort.InferenceSession.create(join(packDir, PACK_FILES.vad), SESSION_OPTIONS),
		loadEmbedModel(packDir, join(packDir, PACK_FILES.ecapa)),
	]);
	const sampleRate = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);

	const createVad = (): Vad => {
		let state: Ort.Tensor = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
		let tail: Float32Array = new Float32Array(VAD_CONTEXT);

		return {
			prob: async (frame) => {
				const next = withContext(tail, frame);
				const out = await vadSession.run({
					input: new ort.Tensor('float32', next.input, [1, VAD_CONTEXT + FRAME]),
					state,
					sr: sampleRate,
				});

				state = out.stateN as Ort.Tensor;
				tail = next.tail;

				return Number((out.output as Ort.Tensor).data[0]);
			},
		};
	};

	return { createVad, embed };
};
