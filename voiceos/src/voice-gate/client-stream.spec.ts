import { beforeEach, describe, expect, it } from 'bun:test';
import { ClientStream } from './client-stream.js';
import { captureLog, fakeVads, pcm, QUIET, DEVELOPER, OTHER } from './test-support.js';

let clock: number;
let readLog: () => Record<string, unknown>[];

const streamWith = (vads = fakeVads()) => ({
	vads,
	stream: new ClientStream({
		client: 'c1',
		createVad: vads.createVad,
		now: () => clock,
		isVoiceOsSpeaking: () => false,
	}),
});

// A tab sends 100 ms chunks.
const send = (stream: ClientStream, level: number, ms: number, sampleRate = 16_000) => {
	for (let sent = 0; sent < ms; sent += 100) {
		stream.observe(pcm(level, 100, sampleRate), sampleRate);
		clock += 100;
	}
};

beforeEach(() => {
	clock = 1_000_000;
	readLog = captureLog();
});

describe('ClientStream', () => {
	it('a slow VAD → frames still heard one at a time, in the order they came', async () => {
		const { stream, vads } = streamWith(fakeVads((index) => (index % 3) * 2));

		send(stream, DEVELOPER, 300);
		send(stream, OTHER, 300);
		await stream.after(() => undefined);

		const firstOther = vads.heard.indexOf(OTHER);

		expect(vads.heard.slice(0, firstOther).every((level) => level === DEVELOPER)).toBe(true);
		expect(vads.heard.slice(firstOther).every((level) => level === OTHER)).toBe(true);
	});

	it('after() → runs once every frame sent before it was heard', async () => {
		const { stream } = streamWith(fakeVads(() => 1));

		send(stream, DEVELOPER, 1_000);

		const ringLength = await stream.after(() => stream.ring.length);

		// 1 s at 16 kHz in 512-sample frames.
		expect(ringLength).toBe(31);
	});

	it('48 kHz audio → resampled to the same frames per second as 16 kHz', async () => {
		const { stream } = streamWith();

		send(stream, DEVELOPER, 1_000, 48_000);

		expect(await stream.after(() => stream.ring.length)).toBe(31);
	});

	it('a pause of over a second → a fresh VAD, and a reset line', async () => {
		const { stream, vads } = streamWith();

		send(stream, DEVELOPER, 300);
		clock += 5_000;
		send(stream, DEVELOPER, 300);
		await stream.after(() => undefined);

		expect(vads.created()).toBe(2);
		expect(readLog().some((line) => line.msg === 'stream reset')).toBe(true);
	});

	it('the models falling more than 5 s behind → the oldest audio dropped and said', async () => {
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { stream } = streamWith({
			...fakeVads(),
			createVad: () => ({
				prob: async () => {
					await held;

					return 0.9;
				},
			}),
		});

		send(stream, DEVELOPER, 8_000);
		release();
		await stream.after(() => undefined);

		expect(stream.ring.length).toBeLessThanOrEqual(Math.ceil(5_000 / 32) + 1);
		// The first frame was already with the VAD; after it, the oldest 3 s were dropped.
		expect((stream.ring[1]?.at ?? 0) - 1_000_000).toBeGreaterThanOrEqual(2_900);
		expect(readLog().some((line) => line.msg === 'behind')).toBe(true);
	});

	it('the ring → only the last minute of audio', async () => {
		const { stream } = streamWith();

		// Heard as it is sent, the way a live mic is: the backlog cap never comes into it.
		for (let second = 0; second < 70; second++) {
			send(stream, QUIET, 1_000);
			await stream.after(() => undefined);
		}

		const lastAt = clock - 100;
		const oldest = stream.ring[0]?.at ?? 0;

		expect(lastAt - oldest).toBeGreaterThan(59_800);
		expect(lastAt - oldest).toBeLessThanOrEqual(60_000);
	});

	it('scoring started → each utterance scored and logged with the tab’s rate', async () => {
		const { stream } = streamWith();

		stream.startScoring(() => Promise.resolve(0.8));
		send(stream, DEVELOPER, 1_500);
		send(stream, QUIET, 600);

		const scores = await stream.after(() => stream.scores);

		expect(scores.map((score) => [score.kind, score.accepted])).toEqual([['first', true]]);
		expect(readLog().find((line) => line.msg === 'score')).toMatchObject({
			client: 'c1',
			sampleRate: 16_000,
			score: 0.8,
			kind: 'first',
		});
	});

	it('closed → queued audio is not heard, but a waiting read still resolves', async () => {
		const { stream, vads } = streamWith(fakeVads(() => 1));

		send(stream, DEVELOPER, 1_000);
		stream.close();

		expect(await stream.after(() => 'done')).toBe('done');
		expect(vads.heard.length).toBeLessThanOrEqual(1);
	});

	it('another rate on the same tab (a press, then listening) → a fresh VAD', async () => {
		const { stream, vads } = streamWith();

		send(stream, DEVELOPER, 300, 44_100);
		send(stream, DEVELOPER, 300, 48_000);
		await stream.after(() => undefined);

		expect(vads.created()).toBe(2);
	});

	it('the chunk it is shown → left exactly as it was', () => {
		const { stream } = streamWith();
		const chunk = pcm(DEVELOPER, 100);
		const before = [...chunk];

		stream.observe(chunk, 16_000);

		expect([...chunk]).toEqual(before);
	});

	it('a model that fails once → logged, and the audio after it still heard', async () => {
		const vads = fakeVads();
		let calls = 0;
		const { stream } = streamWith({
			...vads,
			createVad: () => {
				calls += 1;

				if (calls === 1) {
					throw new Error('model broke');
				}

				return vads.createVad();
			},
		});

		send(stream, DEVELOPER, 300);
		clock += 5_000;
		send(stream, DEVELOPER, 300);
		await stream.after(() => undefined);

		expect(readLog().some((line) => line.msg === 'job failed')).toBe(true);
		expect(vads.heard.length).toBeGreaterThan(0);
	});

	it('a press released mid-word, still undecided → scored when the turn is read', async () => {
		const { stream } = streamWith();

		stream.startScoring(() => Promise.resolve(0.8));
		send(stream, DEVELOPER, 500);

		const scores = await stream.after(async () => {
			await stream.finishUtterance();

			return stream.scores;
		});

		expect(scores.map((score) => score.kind)).toEqual(['first']);
	});
});
