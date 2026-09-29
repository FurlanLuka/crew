// Fakes for the voice gate's tests: audio whose sample value says who is speaking, a VAD that hears
// speech above a level, and an embedding that points one way per speaker.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import type { Embed, Vad } from './models.js';
import type { LearnedVoice, VoiceStore } from './voice-gate.js';

export const QUIET = 0.01;
export const DEVELOPER = 0.5;
export const OTHER = 0.3;
// The developer's talking voice, for the graded embedding: close to the reading voice, not the same.
export const TALKING = 0.4;
// The developer on a bad day: kept by the gate, not clear enough to learn from.
export const WEAK = 0.2;

// 16-bit PCM of one level: level ≥ 0.2 is speech to fakeVad, and fakeEmbed tells levels apart.
export const pcm = (level: number, ms: number, sampleRate = 16_000): Uint8Array => {
	const count = Math.round((sampleRate * ms) / 1000);
	const bytes = new Uint8Array(count * 2);
	const view = new DataView(bytes.buffer);

	for (let index = 0; index < count; index++) {
		view.setInt16(index * 2, Math.round(level * 32767), true);
	}

	return bytes;
};

export const levelOf = (samples: Float32Array): number =>
	Math.round((samples.at(-1) ?? 0) * 100) / 100;

export interface FakeVads {
	createVad: () => Vad;
	created: () => number;
	heard: number[];
}

export const fakeVads = (delay?: (frameIndex: number) => number): FakeVads => {
	let created = 0;
	let frameIndex = 0;
	const heard: number[] = [];

	return {
		heard,
		created: () => created,
		createVad: () => {
			created += 1;

			return {
				prob: async (frame) => {
					const wait = delay?.(frameIndex++) ?? 0;

					if (wait > 0) {
						await Bun.sleep(wait);
					}

					heard.push(levelOf(frame));

					return levelOf(frame) >= 0.2 ? 0.9 : 0;
				},
			};
		},
	};
};

// One axis per speaker level: the same speaker scores 1 against itself, another 0.
// The speaker model's size: a fake the store would reject could not test a save and reload.
const EMBEDDING_LENGTH = 192;

export const fakeEmbed: Embed = (audio) => {
	const vector = new Float32Array(EMBEDDING_LENGTH);

	vector[Math.round(levelOf(audio) * 10) % 8] = 1;

	return Promise.resolve(vector);
};

// Where each level points for gradedEmbed: the reading voice (DEVELOPER), the talking voice at
// 0.64 to it, another voice at 0.3, a weak turn at 0.55, so learning can be seen moving scores.
const GRADED: Record<string, number[]> = {
	'0.5': [1, 0, 0],
	'0.4': [0.64, 0.768, 0],
	'0.3': [0.3, 0, 0.954],
	'0.2': [0.55, 0, 0.835],
};

export const gradedEmbed: Embed = (audio) => {
	const vector = new Float32Array(EMBEDDING_LENGTH);

	vector.set(GRADED[String(levelOf(audio))] ?? [0, 0, 1]);

	return Promise.resolve(vector);
};

export interface MemoryStore extends VoiceStore {
	saved: LearnedVoice[];
	deletes: number;
	latest: () => LearnedVoice | null;
}

export const memoryStore = (): MemoryStore => {
	const saved: LearnedVoice[] = [];
	let deletes = 0;
	let isDeleted = false;

	return {
		saved,
		get deletes() {
			return deletes;
		},
		save: (voice) => {
			isDeleted = false;
			saved.push({ ...voice, recentScores: [...voice.recentScores] });
		},
		delete: () => {
			deletes += 1;
			isDeleted = true;
		},
		latest: () => (isDeleted ? null : (saved.at(-1) ?? null)),
	};
};

const logDir = mkdtempSync(join(tmpdir(), 'voice-gate-log-'));
let logCount = 0;

process.on('exit', () => rmSync(logDir, { recursive: true, force: true }));

export const captureLog = (): (() => Record<string, unknown>[]) => {
	logCount += 1;

	const file = join(logDir, `${logCount}.jsonl`);

	configureLog({ file, quiet: true });

	return () => {
		try {
			return readFileSync(file, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		} catch {
			return [];
		}
	};
};
