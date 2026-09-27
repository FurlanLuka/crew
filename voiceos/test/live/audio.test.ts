// Replays the committed Soniox-TTS fixtures through real Soniox STT: costs a fraction of a cent per run.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKeys, resolvePaths } from '../../src/config.js';
import { configureLog } from '../../src/log.js';
import { writeSpokenRefs } from '../../src/router/refs.js';
import { normalizeUtterance } from '../../src/shared/spoken.js';
import { SttSession } from '../../src/speech/stt.js';
import { buildContextTerms } from '../../src/speech/tokens.js';
import { decodeWav } from '../../src/speech/wav.js';
import { FIXTURE_REFS } from '../support/state.js';

interface AudioCase {
	id: string;
	text: string;
	heard: string[];
}

interface Transcription {
	text: string;
	finalizeMs: number;
}

interface VariantResult {
	id: string;
	variant: string;
	ok: boolean;
	heard: string;
}

configureLog({ quiet: true });
const audioDir = join(import.meta.dir, '..', '..', 'evals', 'audio');
const { cases } = JSON.parse(readFileSync(join(audioDir, 'cases.json'), 'utf8')) as {
	cases: AudioCase[];
};
const sonioxKey = loadKeys(resolvePaths()).soniox;
const VARIANTS = ['clean', 'noise', 'fast'] as const;

// In CI a missing secret must fail the job, not skip every test and pass.
if (process.env.CI && !sonioxKey) {
	throw new Error('SONIOX_API_KEY is required in CI');
}

const loadFixture = (id: string, variant: string): Int16Array =>
	decodeWav(new Uint8Array(readFileSync(join(audioDir, 'fixtures', `${id}.${variant}.wav`))));

export const transcribe = (pcm: Int16Array, apiKey: string, pace = 5): Promise<Transcription> => {
	// pace: times faster than real time; the mic streams in real time, command tests go faster.
	// Set once the last audio is sent; finalize time counts from there.
	let releasedAt = 0;

	return new Promise((resolve, reject) => {
		const session = new SttSession({
			apiKey,
			terms: buildContextTerms({ refs: FIXTURE_REFS, topics: [] }),
			onPartial: () => {},
			onFinal: (text) => resolve({ text, finalizeMs: Date.now() - releasedAt }),
			onError: (message) => reject(new Error(message)),
		});
		const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);

		(async () => {
			for (let i = 0; i < bytes.byteLength; i += 3200) {
				session.send(bytes.subarray(i, i + 3200));
				await Bun.sleep(100 / pace);
			}

			// The mic sends 250 ms past the release (web/ptt.ts); Soniox finalizes fastest after silence.
			session.send(new Uint8Array(16000 * 2 * 0.25));
			releasedAt = Date.now();
			await session.end();
		})();
	});
};

export const findMissingWords = (heard: string, words: string[]): string[] => {
	// Names count as said or as written refs; "a|b" accepts either.
	const text = normalizeUtterance(
		`${heard} ${writeSpokenRefs({ text: heard, refs: FIXTURE_REFS })}`,
	);
	// Whole words: "now" must not pass for "no", nor "yesterday" for "yes".
	const wasSaid = (alternative: string) =>
		new RegExp(`(?<![\\w/-])${alternative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`).test(
			text,
		);

	return words.filter((entry) => !entry.split('|').some(wasSaid));
};

describe.skipIf(!sonioxKey || process.env.VOICEOS_AUDIO === '0')(
	'spoken commands → actions (Soniox)',
	() => {
		const results: VariantResult[] = [];

		for (const audioCase of cases) {
			for (const variant of VARIANTS) {
				it(`${audioCase.id} (${variant})`, async () => {
					const pcm = loadFixture(audioCase.id, variant);
					const { text: heard } = await transcribe(pcm, sonioxKey as string);
					const missing = findMissingWords(heard, audioCase.heard);
					const isOk = missing.length === 0;
					results.push({ id: audioCase.id, variant, ok: isOk, heard });

					// Clean audio must always work; degraded variants are scored below.
					if (variant === 'clean') {
						expect({ heard, missing }).toEqual({ heard, missing: [] });
					}
				}, 30_000);
			}
		}

		it('degraded audio (noise, 1.2x) → at least 80% still keep the key words', () => {
			const degraded = results.filter((result) => result.variant !== 'clean');

			// Scored from the runs above; under -t filtering there may be none.
			if (degraded.length === 0) {
				return;
			}

			const passedCount = degraded.filter((result) => result.ok).length;
			const failures = degraded
				.filter((result) => !result.ok)
				.map((result) => `${result.id}/${result.variant}: "${result.heard}"`);
			expect({ rate: passedCount / Math.max(degraded.length, 1), failures }).toMatchObject({
				rate: expect.any(Number),
			});
			expect(passedCount / Math.max(degraded.length, 1)).toBeGreaterThanOrEqual(0.8);
		});

		it('release → transcript in under a second at real-time pace (Soniox finalize)', async () => {
			// The 2–3 s it took before finalize is what this guards.
			const finalizeTimes: number[] = [];

			for (const audioCase of cases.slice(0, 5)) {
				const pcm = loadFixture(audioCase.id, 'clean');
				finalizeTimes.push((await transcribe(pcm, sonioxKey as string, 1)).finalizeMs);
			}

			console.log(`finalize ms at real-time pace: ${finalizeTimes.join(', ')}`);
			expect(Math.max(...finalizeTimes)).toBeLessThan(1000);
		}, 60_000);

		it('hands-free → two commands a pause apart come back as two turns from one stream', async () => {
			// Soniox's endpoint detection must end each turn on its own, with no finalize.
			const [first, second] = cases.slice(0, 2);
			const loadCleanClip = (audioCase: AudioCase | undefined) =>
				loadFixture(`${audioCase?.id}`, 'clean');
			const createSilence = (seconds: number) => new Int16Array(Math.round(16000 * seconds));
			const parts = [
				loadCleanClip(first),
				createSilence(2.5),
				loadCleanClip(second),
				createSilence(2.5),
			];
			const segments: { text: string; at: number }[] = [];
			const errors: string[] = [];
			const session = new SttSession({
				apiKey: sonioxKey as string,
				terms: buildContextTerms({ refs: FIXTURE_REFS, topics: [] }),
				onPartial: () => {},
				onFinal: () => {},
				onError: (message) => errors.push(message),
				onSegment: (text) => segments.push({ text, at: Date.now() }),
			});
			const startedAt = Date.now();

			for (const part of parts) {
				const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);

				for (let i = 0; i < bytes.byteLength; i += 3200) {
					session.send(bytes.subarray(i, i + 3200));
					await Bun.sleep(100);
				}
			}

			const deadline = Date.now() + 4000;

			while (segments.length < 2 && Date.now() < deadline) {
				await Bun.sleep(50);
			}

			session.cancel();

			console.log(
				'hands-free turns:',
				segments.map((segment) => `${segment.text} (+${segment.at - startedAt} ms)`),
			);
			expect(errors).toEqual([]);
			expect(segments).toHaveLength(2);
			const splitWords = (text: string | undefined) =>
				(text ?? '')
					.toLowerCase()
					.replace(/[^a-z0-9 ]/g, '')
					.split(' ')
					.filter(Boolean);

			for (const [i, audioCase] of [first, second].entries()) {
				const heard = splitWords(segments[i]?.text);
				const expected = splitWords(audioCase?.text);
				expect(
					expected.filter((word) => heard.includes(word)).length / expected.length,
				).toBeGreaterThanOrEqual(0.6);
			}
		}, 60_000);
	},
);
