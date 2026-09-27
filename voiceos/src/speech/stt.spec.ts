import { afterEach, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import { configureLog } from '../log.js';
import { SttSession } from './stt.js';

configureLog({ quiet: true });

interface FakeSocket {
	send: (data: string) => void;
	close: () => void;
}

type Script = (socket: FakeSocket, frames: (string | number)[]) => void;

interface CreateSessionParams {
	sampleRate?: number;
	finalizeTimeoutMs?: number;
	onSegment?: (text: string) => void;
}

// A local stand-in for Soniox's WebSocket: records frames (text as-is, binary as byte length).
const createFakeSoniox = (onFrame: Script) => {
	const frames: (string | number)[] = [];
	const server: Server<undefined> = Bun.serve({
		port: 0,
		fetch: (request, bunServer) => (bunServer.upgrade(request) ? undefined : new Response('no')),
		websocket: {
			message(socket, data) {
				frames.push(typeof data === 'string' ? data : data.byteLength);
				onFrame(socket, frames);
			},
		},
	});

	return { url: `ws://localhost:${server.port}`, frames, stop: () => server.stop(true) };
};

let stop: (() => void) | null = null;
afterEach(() => stop?.());

const createSession = (url: string, extra: CreateSessionParams = {}) => {
	const captured = {
		partials: [] as string[],
		finals: [] as string[],
		errors: [] as string[],
		causes: [] as string[],
	};
	const session = new SttSession({
		apiKey: 'k',
		terms: ['store-front/main'],
		url,
		...extra,
		onPartial: (text) => captured.partials.push(text),
		onFinal: (text) => captured.finals.push(text),
		onError: (message, cause) => {
			captured.errors.push(message);
			captured.causes.push(cause);
		},
	});

	return { session, captured };
};

const waitUntil = async (check: () => boolean) => {
	const deadline = Date.now() + 2000;

	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error('timeout');
		}

		await Bun.sleep(5);
	}
};

describe('SttSession', () => {
	it('config goes first, buffered audio follows, release finalizes: text taken at <fin>, then the stream ends', async () => {
		const fake = createFakeSoniox((socket, frames) => {
			if (frames.at(-1) === JSON.stringify({ type: 'finalize' })) {
				socket.send(
					JSON.stringify({
						tokens: [
							{ text: 'why is this', is_final: true },
							{ text: ' so slow', is_final: true },
							{ text: '<fin>', is_final: true },
						],
					}),
				);
			}
		});
		stop = fake.stop;
		const { session, captured } = createSession(fake.url, { sampleRate: 48000 });
		session.send(new Uint8Array(3200));
		await session.end();
		await waitUntil(() => captured.finals.length === 1);
		await waitUntil(() => fake.frames.at(-1) === '');

		const config = JSON.parse(String(fake.frames[0]));
		expect(config).toMatchObject({
			model: 'stt-rt-v5',
			audio_format: 'pcm_s16le',
			sample_rate: 48000,
			context: { terms: ['store-front/main'] },
		});
		expect(fake.frames.slice(1)).toEqual([3200, JSON.stringify({ type: 'finalize' }), '']);
		expect(captured.finals).toEqual(['why is this so slow']);
	});

	it('no sample rate given → 16 kHz, what the audio fixtures are', async () => {
		const fake = createFakeSoniox(() => {});
		stop = fake.stop;
		const { session } = createSession(fake.url);
		await waitUntil(() => fake.frames.length === 1);
		expect(JSON.parse(String(fake.frames[0]))).toMatchObject({ sample_rate: 16000 });
		session.cancel();
	});

	it('no <fin> in time → the stream is ended the old way and its transcript still comes back once', async () => {
		const fake = createFakeSoniox((socket, frames) => {
			if (frames.at(-1) === '') {
				socket.send(JSON.stringify({ tokens: [{ text: 'late', is_final: true }] }));
				socket.send(JSON.stringify({ tokens: [], finished: true }));
			}
		});
		stop = fake.stop;
		const { session, captured } = createSession(fake.url, { finalizeTimeoutMs: 30 });
		session.send(new Uint8Array(10));
		await session.end();
		await waitUntil(() => captured.finals.length === 1);
		await Bun.sleep(30);

		expect(captured.finals).toEqual(['late']);
	});

	it('partial tokens → onPartial with the running transcript', async () => {
		const fake = createFakeSoniox((socket, frames) => {
			if (frames.length === 2) {
				socket.send(JSON.stringify({ tokens: [{ text: 'Open', is_final: false }] }));
			}
		});
		stop = fake.stop;
		const { session, captured } = createSession(fake.url);
		session.send(new Uint8Array(10));
		await waitUntil(() => captured.partials.length === 1);

		expect(captured.partials).toEqual(['Open']);
		session.cancel();
	});

	it('error response → onError, never onFinal', async () => {
		const fake = createFakeSoniox((socket) =>
			socket.send(JSON.stringify({ error_code: 401, error_message: 'bad key' })),
		);
		stop = fake.stop;
		const { captured } = createSession(fake.url);
		await waitUntil(() => captured.errors.length === 1);
		await Bun.sleep(20);

		expect(captured.errors[0]).toContain('401');
		expect(captured.causes).toEqual(['soniox']);
		expect(captured.finals).toEqual([]);
	});

	it('socket closes without finished → onFinal exactly once', async () => {
		const fake = createFakeSoniox((socket, frames) => {
			if (frames.length === 2) {
				socket.send(JSON.stringify({ tokens: [{ text: 'yes', is_final: true }] }));
				socket.close();
			}
		});
		stop = fake.stop;
		const { session, captured } = createSession(fake.url);
		session.send(new Uint8Array(10));
		await waitUntil(() => captured.finals.length > 0);
		await Bun.sleep(30);

		expect(captured.finals).toEqual(['yes']);
	});

	it('non-JSON frame → ignored, the stream carries on', async () => {
		const fake = createFakeSoniox((socket, frames) => {
			if (frames.length === 2) {
				socket.send('garbage');
				socket.send(JSON.stringify({ tokens: [{ text: 'ok', is_final: true }], finished: true }));
			}
		});
		stop = fake.stop;
		const { session, captured } = createSession(fake.url);
		session.send(new Uint8Array(10));
		await waitUntil(() => captured.finals.length === 1);

		expect(captured.finals).toEqual(['ok']);
	});

	it('Soniox never answers the finalize or the end frame → the utterance fails instead of hanging', async () => {
		const fake = createFakeSoniox(() => {});
		stop = fake.stop;
		const { session, captured } = createSession(fake.url, { finalizeTimeoutMs: 30 });
		session.send(new Uint8Array(10));
		await session.end();
		await waitUntil(() => captured.errors.length === 1);

		expect(captured.errors[0]).toContain('in time');
		expect(captured.finals).toEqual([]);
	});

	it('unreachable server → onError; end() does not throw', async () => {
		const { session, captured } = createSession('ws://localhost:1');
		await session.end();
		await waitUntil(() => captured.errors.length === 1);
		expect(captured.causes).toEqual(['connection']);

		expect(captured.finals).toEqual([]);
	});

	it('hands-free → endpoint detection on; each <end> hands over one turn and the stream stays open', async () => {
		const fake = createFakeSoniox((socket, frames) => {
			if (frames.length === 2) {
				socket.send(
					JSON.stringify({
						tokens: [
							{ text: 'go home', is_final: true },
							{ text: '<end>', is_final: true },
							{ text: 'open', is_final: false },
						],
					}),
				);
			}

			if (frames.length === 3) {
				socket.send(
					JSON.stringify({
						tokens: [
							{ text: 'open store front', is_final: true },
							{ text: '<end>', is_final: true },
						],
					}),
				);
			}
		});
		stop = fake.stop;
		const segments: string[] = [];
		const { session, captured } = createSession(fake.url, {
			onSegment: (text) => segments.push(text),
		});
		session.send(new Uint8Array(10));
		await waitUntil(() => segments.length === 1);
		expect(captured.partials.at(-1)).toBe('open');
		session.send(new Uint8Array(10));
		await waitUntil(() => segments.length === 2);
		await Bun.sleep(20);

		expect(JSON.parse(String(fake.frames[0]))).toMatchObject({
			enable_endpoint_detection: true,
			max_endpoint_delay_ms: 1500,
		});
		expect(segments).toEqual(['go home', 'open store front']);
		expect(captured.finals).toEqual([]);
		expect(fake.frames).not.toContain('');
		session.cancel();
	});

	it('push-to-talk → endpoint detection off', async () => {
		const fake = createFakeSoniox(() => {});
		stop = fake.stop;
		const { session } = createSession(fake.url);
		await waitUntil(() => fake.frames.length === 1);
		const config = JSON.parse(String(fake.frames[0]));
		expect(config.enable_endpoint_detection).toBe(false);
		expect(config.max_endpoint_delay_ms).toBeUndefined();
		session.cancel();
	});
});
