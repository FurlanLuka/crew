// The voice gate's real models, run from an unpacked pack: free, but needs the pack on disk.
//   VOICEOS_VOICE_GATE_PACK_DIR=<pack dir> bun test test/live/voice-gate.test.ts
// (dist/voice-gate/<os>-<arch> after scripts/voice-gate/build-packs.ts, or ~/.crew/voiceos/voice-gate/<id>)
// The offline comparison's other models also need VOICEOS_VOICE_GATE_CANDIDATES=<dir> (what
// scripts/voice-gate/export_candidates.py wrote); the pack still supplies the runtime.
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureLog } from '../../src/log.js';
import { decodeWav } from '../../src/speech/wav.js';
import { blend } from '../../src/voice-gate/adaptation.js';
import { cosine } from '../../src/voice-gate/enrollment.js';
import { evaluate, type Recording } from '../../src/voice-gate/evaluate.js';
import { FRAME, SAMPLE_RATE } from '../../src/voice-gate/gate.js';
import { loadEmbedModel, loadModels } from '../../src/voice-gate/models.js';
import { Resampler } from '../../src/voice-gate/resample.js';
import references from '../../src/voice-gate/testdata/references.json';
import { VoiceGate } from '../../src/voice-gate/voice-gate.js';
import type { VoiceGateStatus } from '../../src/shared/protocol.js';

const packDir = process.env.VOICEOS_VOICE_GATE_PACK_DIR;
const candidatesDir = process.env.VOICEOS_VOICE_GATE_CANDIDATES;
const FIXTURES = join(import.meta.dir, '..', '..', 'evals', 'audio', 'fixtures');

// The audio evals' Soniox TTS clips: three of one voice, the rest of others.
const SAME_VOICE = ['deny-reason', 'why-slow', 'open-wrk1'];
const OTHER_VOICES = ['address-main', 'dictation', 'status', 'kernel-start-topic', 'pick-second'];

configureLog({ quiet: true });

const readPcm = (name: string): Int16Array =>
	decodeWav(new Uint8Array(readFileSync(join(FIXTURES, `${name}.clean.wav`))));

const toFloat = (pcm: Int16Array): Float32Array =>
	Float32Array.from(pcm, (sample) => sample / 32768);

const toBytes = (pcm: Int16Array): Uint8Array =>
	new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);

const repeatTo = (audio: Float32Array, seconds: number): Float32Array => {
	const out = new Float32Array(seconds * SAMPLE_RATE);

	for (let at = 0; at < out.length; at += audio.length) {
		out.set(audio.subarray(0, out.length - at), at);
	}

	return out;
};

// Linear interpolation up to a browser's rate, for the resampler to bring back down.
const upsample = (audio: Float32Array, factor: number): Float32Array =>
	Float32Array.from({ length: audio.length * factor }, (_, index) => {
		const position = index / factor;
		const left = audio[Math.floor(position)] ?? 0;
		const right = audio[Math.ceil(position)] ?? left;

		return left + (right - left) * (position - Math.floor(position));
	});

describe.skipIf(!packDir)('voice gate models (live)', () => {
	const models = packDir ? loadModels(packDir) : Promise.reject(new Error('no pack'));

	it('ECAPA in Bun → the embedding PyTorch gave for the same clip', async () => {
		const { embed } = await models;
		const embedding = await embed(toFloat(readPcm(references.clip.replace('.clean.wav', ''))));

		expect(cosine(embedding, Float32Array.from(references.ecapa))).toBeGreaterThan(0.999);
	});

	it('Silero in Bun, with its context and state → the Python wrapper’s probabilities', async () => {
		const vad = (await models).createVad();
		const audio = toFloat(readPcm(references.clip.replace('.clean.wav', '')));
		const probs: number[] = [];

		for (let at = 0; at + FRAME <= audio.length; at += FRAME) {
			probs.push(await vad.prob(audio.slice(at, at + FRAME)));
		}

		const worst = Math.max(
			...probs.map((prob, index) => Math.abs(prob - (references.silero[index] ?? 0))),
		);

		expect(probs).toHaveLength(references.silero.length);
		expect(worst).toBeLessThanOrEqual(0.01);
	});

	it('the same voice → scores above every other voice', async () => {
		const { embed } = await models;
		const [first, second, held] = SAME_VOICE.map((name) => toFloat(readPcm(name)));
		const voiceprint = await embed(
			Float32Array.from([...(first as Float32Array), ...(second as Float32Array)]),
		);
		const same = cosine(await embed(held as Float32Array), voiceprint);
		const others = await Promise.all(
			OTHER_VOICES.map(async (name) => cosine(await embed(toFloat(readPcm(name))), voiceprint)),
		);

		console.info(
			'same voice',
			same.toFixed(3),
			'others',
			others.map((s) => s.toFixed(3)).join(' '),
		);
		expect(same).toBeGreaterThan(Math.max(...others));
	});

	it('learning from one more clip of the voice → the gap to other voices widens', async () => {
		const { embed } = await models;
		const [enrolledClip, learnedClip, heldOutClip] = await Promise.all(
			SAME_VOICE.map(async (name) => embed(toFloat(readPcm(name)))),
		);
		const others = await Promise.all(
			OTHER_VOICES.map(async (name) => embed(toFloat(readPcm(name)))),
		);
		const gap = (voiceprint: Float32Array) =>
			cosine(heldOutClip as Float32Array, voiceprint) -
			Math.max(...others.map((other) => cosine(other, voiceprint)));
		const enrolled = enrolledClip as Float32Array;
		const learned = blend(enrolled, learnedClip as Float32Array, 0.2);

		const closestOther = (voiceprint: Float32Array) =>
			Math.max(...others.map((other) => cosine(other, voiceprint)));

		console.info('gap before', gap(enrolled).toFixed(3), 'after', gap(learned).toFixed(3));
		expect(gap(learned)).toBeGreaterThan(gap(enrolled));
		// Learning one voice does not draw the others closer.
		expect(closestOther(learned)).toBeLessThanOrEqual(closestOther(enrolled) + 0.01);
	});

	it('48 kHz from the browser, resampled → the same speaker as the 16 kHz original', async () => {
		const { embed } = await models;
		const native = toFloat(readPcm('dictation'));
		const resampled = new Resampler(48_000).push(upsample(native, 3));

		expect(cosine(await embed(resampled), await embed(native))).toBeGreaterThan(0.98);
	});

	it('a minute of speech through VAD and scoring → well under real time', async () => {
		const { createVad, embed } = await models;
		const vad = createVad();
		const audio = repeatTo(toFloat(readPcm('dictation')), 60);
		const startedAt = performance.now();

		for (let at = 0, frame = 0; at + FRAME <= audio.length; at += FRAME, frame++) {
			await vad.prob(audio.slice(at, at + FRAME));

			if (frame % 31 === 30) {
				await embed(audio.slice(Math.max(0, at - 47 * FRAME), at + FRAME));
			}
		}

		const ms = performance.now() - startedAt;

		console.info(`a minute of audio through the gate's models: ${ms.toFixed(0)} ms`);
		// Measured ~4 s on an M-series Mac: three times that is still a fifth of real time.
		expect(ms).toBeLessThan(12_000);
	}, 30_000);

	it('the whole gate: learns a voice from its turns, then keeps it and flags another', async () => {
		const { createVad, embed } = await models;
		const statuses: VoiceGateStatus[] = [];
		let clock = 1_000_000;
		const gate = new VoiceGate({
			createVad,
			embed,
			setStatus: (status) => statuses.push(status),
			now: () => clock,
			isVoiceOsSpeaking: () => false,
			store: { save: () => undefined, delete: () => undefined },
		});

		const say = async (name: string) => {
			const from = clock;
			const pcm = readPcm(name);
			const chunk = SAMPLE_RATE / 10;

			for (let at = 0; at < pcm.length; at += chunk) {
				gate.observe('tab', toBytes(pcm.slice(at, at + chunk)), SAMPLE_RATE);
				clock += 100;
			}

			for (let quiet = 0; quiet < 8; quiet++) {
				gate.observe('tab', new Uint8Array(chunk * 2), SAMPLE_RATE);
				clock += 100;
			}

			await gate.turnDelivered('tab', { from, to: clock, source: 'push' });
		};

		for (let round = 0; round < 8 && statuses.at(-1)?.phase !== 'scoring'; round++) {
			for (const name of SAME_VOICE) {
				await say(name);
			}
		}

		expect(statuses.at(-1)).toMatchObject({ phase: 'scoring', lastScore: null });

		await say('why-slow');
		const developer = statuses.at(-1);
		await say('address-main');
		const other = statuses.at(-1);

		console.info('developer', JSON.stringify(developer), 'other', JSON.stringify(other));
		expect(developer?.phase === 'scoring' && (developer.lastScore ?? 0) >= 0.4).toBe(true);
		expect(other?.phase === 'scoring' && (other.lastScore ?? 1) < 0.4).toBe(true);
	}, 60_000);

	it('the offline comparison on recordings made from the fixtures → a result per variant, the voice told apart', async () => {
		const { createVad, embed } = await models;

		const toRecording = async (
			name: string,
			label: 'turn' | 'other',
			at: number,
		): Promise<Recording> => {
			const audio = toFloat(readPcm(name));
			const vad = createVad();
			const frames: Float32Array[] = [];
			const probs: number[] = [];

			for (let offset = 0; offset + FRAME <= audio.length; offset += FRAME) {
				const frame = audio.slice(offset, offset + FRAME);

				frames.push(frame);
				probs.push(await vad.prob(frame));
			}

			return {
				name,
				label,
				at,
				frames,
				probs,
				voiceOsSpeaking: frames.map(() => false),
				turnCoverage: label === 'turn' ? 1 : 0,
				source: label === 'turn' ? 'push' : null,
			};
		};

		const recordings = await Promise.all([
			...[...SAME_VOICE, ...SAME_VOICE].map((name, index) => toRecording(name, 'turn', index)),
			...OTHER_VOICES.map((name, index) => toRecording(name, 'other', 100 + index)),
		]);
		const results = await evaluate(recordings, embed);

		for (const result of results) {
			console.info(
				result.variant.padEnd(20),
				'you median',
				result.you.median?.toFixed(2),
				'others median',
				result.others.median?.toFixed(2),
				'EER',
				result.eer?.rate.toFixed(2),
			);
		}

		expect(results).toHaveLength(6);
		expect(results.every((result) => result.others.count === OTHER_VOICES.length)).toBe(true);
		expect(results[0]?.you.median ?? 0).toBeGreaterThan(results[0]?.others.median ?? 1);
	}, 120_000);

	it('a graph without the wav → embedding contract → refused, naming what it has', async () => {
		await expect(
			loadEmbedModel(packDir as string, join(packDir as string, 'silero_vad.onnx')),
		).rejects.toThrow('not wav → embedding');
	});
});

describe.skipIf(!packDir || !candidatesDir)('candidate speaker models (live)', () => {
	const names = candidatesDir
		? readdirSync(candidatesDir)
				.filter((name) => name.endsWith('.onnx'))
				.map((name) => name.slice(0, -'.onnx'.length))
		: [];

	it('some were exported', () => {
		expect(names.length).toBeGreaterThan(0);
	});

	for (const name of names) {
		const load = () =>
			loadEmbedModel(packDir as string, join(candidatesDir as string, `${name}.onnx`));

		it(`${name} in Bun → the embedding Python gave for the same clip, unit length`, async () => {
			const embed = await load();
			const reference = JSON.parse(
				readFileSync(join(candidatesDir as string, `${name}.reference.json`), 'utf8'),
			) as { clip: string; embedding: number[] };
			const got = await embed(toFloat(readPcm(reference.clip.replace('.clean.wav', ''))));
			const norm = Math.hypot(...got);

			expect(norm).toBeCloseTo(1, 4);
			expect(cosine(got, Float32Array.from(reference.embedding))).toBeGreaterThan(0.999);
		});

		it(`${name}: the same voice → scores above every other voice`, async () => {
			const embed = await load();
			const [first, second, held] = SAME_VOICE.map((clip) => toFloat(readPcm(clip)));
			const voiceprint = await embed(
				Float32Array.from([...(first as Float32Array), ...(second as Float32Array)]),
			);
			const same = cosine(await embed(held as Float32Array), voiceprint);
			const others = await Promise.all(
				OTHER_VOICES.map(async (clip) => cosine(await embed(toFloat(readPcm(clip))), voiceprint)),
			);

			console.info(
				name,
				'same voice',
				same.toFixed(3),
				'others',
				others.map((s) => s.toFixed(3)).join(' '),
			);
			expect(same).toBeGreaterThan(Math.max(...others));
		});
	}
});
