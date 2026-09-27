// Streams speech from real Soniox TTS. Needs a Soniox key; costs a fraction of a cent per run.
import { afterAll, describe, expect, it } from 'bun:test';
import { loadKeys, resolvePaths } from '../../src/config.js';
import { configureLog } from '../../src/log.js';
import { computePcmSeconds, SonioxTts } from '../../src/speech/tts.js';

configureLog({ quiet: true });
const sonioxKey = loadKeys(resolvePaths()).soniox;

if (process.env.CI && !sonioxKey) {
	throw new Error('SONIOX_API_KEY is required in CI');
}

const tts = sonioxKey ? new SonioxTts({ apiKey: sonioxKey }) : null;
afterAll(() => tts?.close());

const streamSpeech = (id: string, text: string, signal = new AbortController().signal) => {
	const startedAt = Date.now();
	const progress = { firstChunkMs: -1, bytes: 0 };
	const done = (tts as SonioxTts).synthesize({
		id,
		text,
		signal,
		onAudio: (pcm) => {
			if (progress.firstChunkMs < 0) {
				progress.firstChunkMs = Date.now() - startedAt;
			}

			progress.bytes += pcm.byteLength;
		},
	});

	return { progress, done };
};

describe.skipIf(!sonioxKey)('live Soniox streaming TTS', () => {
	it('a spoken line → first audio well before the clip is done, whole clip arrives', async () => {
		const { progress, done } = streamSpeech(
			'live-1',
			'checkout api finished the tests. All ninety six pass.',
		);
		await done;
		expect(progress.firstChunkMs).toBeGreaterThanOrEqual(0);
		expect(progress.firstChunkMs).toBeLessThan(2000);
		expect(computePcmSeconds(progress.bytes)).toBeGreaterThan(1.5);
	}, 30_000);

	it('cancel mid-clip → it settles at once; the next clip streams on the same connection', async () => {
		const abortController = new AbortController();
		const longClip = streamSpeech(
			'live-2',
			'This is a long update that will be cut off before it finishes, because the developer started talking over it.',
			abortController.signal,
		);

		while (longClip.progress.bytes === 0) {
			await Bun.sleep(20);
		}

		abortController.abort();
		await longClip.done;

		const nextClip = streamSpeech('live-3', 'store front is waiting on you.');
		await nextClip.done;
		expect(nextClip.progress.bytes).toBeGreaterThan(0);
		expect(nextClip.progress.firstChunkMs).toBeLessThan(1500);
	}, 30_000);
});
