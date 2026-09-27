import { afterEach, describe, expect, it } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import { configureLog } from '../log.js';
import { SonioxTts, computePcmSeconds } from './tts.js';

configureLog({ quiet: true });

type Frame = Record<string, unknown>;
type Peer = ServerWebSocket<undefined>;
type Script = (peer: Peer, frame: Frame) => void;

const createFakeSoniox = (script?: Script) => {
	// Records every frame and connection; by default answers a finished text with two chunks.
	const frames: Frame[] = [];
	const peers: Peer[] = [];
	const server: Server<undefined> = Bun.serve({
		port: 0,
		fetch: (request, bunServer) => (bunServer.upgrade(request) ? undefined : new Response('no')),
		websocket: {
			open: (peer) => {
				peers.push(peer);
			},
			message(peer, data) {
				const frame = JSON.parse(String(data)) as Frame;
				frames.push(frame);

				if (script) {
					script(peer, frame);

					return;
				}

				if (frame.text_end) {
					const id = frame.stream_id;
					peer.send(
						JSON.stringify({
							stream_id: id,
							audio: Buffer.from([1, 0, 2, 0]).toString('base64'),
							audio_end: false,
						}),
					);
					peer.send(
						JSON.stringify({
							stream_id: id,
							audio: Buffer.from([3, 0]).toString('base64'),
							audio_end: true,
						}),
					);
					peer.send(JSON.stringify({ stream_id: id, terminated: true }));
				}

				if (frame.cancel) {
					peer.send(JSON.stringify({ stream_id: frame.stream_id, terminated: true }));
				}
			},
		},
	});

	return { url: `ws://localhost:${server.port}`, frames, peers, stop: () => server.stop(true) };
};

let cleanup: (() => void)[] = [];
afterEach(() => {
	for (const cleanupStep of cleanup) {
		cleanupStep();
	}

	cleanup = [];
});

const setup = (script?: Script, keepAliveMs?: number) => {
	const fake = createFakeSoniox(script);
	const tts = new SonioxTts({ apiKey: 'k', url: fake.url, keepAliveMs });
	cleanup.push(() => tts.close(), fake.stop);

	return { fake, tts };
};

const startClip = (
	tts: SonioxTts,
	id: string,
	text = 'hello',
	signal = new AbortController().signal,
) => {
	const chunks: number[][] = [];
	const done = tts.synthesize({ id, text, signal, onAudio: (pcm) => chunks.push([...pcm]) });

	return { chunks, done };
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

describe('SonioxTts', () => {
	it('clip → config then text on its stream, chunks in order, resolves on terminated', async () => {
		const { fake, tts } = setup();
		const { chunks, done } = startClip(tts, 's1', 'checkout finished');
		await done;

		expect(fake.frames[0]).toMatchObject({
			api_key: 'k',
			model: 'tts-rt-v2',
			voice: 'Isla',
			speed: 1.15,
			audio_format: 'pcm_s16le',
			sample_rate: 24000,
			stream_id: 's1',
		});
		expect(fake.frames[1]).toEqual({ text: 'checkout finished', text_end: true, stream_id: 's1' });
		expect(chunks).toEqual([
			[1, 0, 2, 0],
			[3, 0],
		]);
	});

	it('no clip yet → no socket opened', async () => {
		const { fake } = setup();
		await Bun.sleep(20);
		expect(fake.peers).toHaveLength(0);
	});

	it('two clips → one socket', async () => {
		const { fake, tts } = setup();
		await startClip(tts, 's1').done;
		await startClip(tts, 's2').done;
		expect(fake.peers).toHaveLength(1);
	});

	it('error on one clip → it rejects, the socket serves the next clip', async () => {
		const { fake, tts } = setup((peer, frame) => {
			if (!frame.text_end) {
				return;
			}

			if (frame.stream_id === 'bad') {
				peer.send(
					JSON.stringify({ stream_id: 'bad', error_code: 400, error_message: 'Missing model' }),
				);

				return;
			}

			peer.send(JSON.stringify({ stream_id: frame.stream_id, audio: 'AQA=' }));
			peer.send(JSON.stringify({ stream_id: frame.stream_id, terminated: true }));
		});
		await expect(startClip(tts, 'bad').done).rejects.toThrow('Soniox TTS 400: Missing model');
		const good = startClip(tts, 'good');
		await good.done;
		expect(good.chunks).toEqual([[1, 0]]);
		expect(fake.peers).toHaveLength(1);
	});

	it("cancel clip A, then clip B → A settles at once and sends cancel, B gets none of A's late chunks", async () => {
		let latestPeer: Peer | null = null;
		const { fake, tts } = setup((peer, frame) => {
			latestPeer = peer;

			if (frame.text_end && frame.stream_id === 'b') {
				peer.send(JSON.stringify({ stream_id: 'b', audio: 'AgA=' }));
				peer.send(JSON.stringify({ stream_id: 'b', terminated: true }));
			}
		});
		const abort = new AbortController();
		const clipA = startClip(tts, 'a', 'long', abort.signal);
		await waitUntil(() => fake.frames.length === 2);
		abort.abort();
		await clipA.done;
		await waitUntil(() => fake.frames.length === 3);
		expect(fake.frames.at(-1)).toEqual({ stream_id: 'a', cancel: true });

		const clipB = startClip(tts, 'b');
		(latestPeer as unknown as Peer).send(JSON.stringify({ stream_id: 'a', audio: 'CQA=' }));
		await clipB.done;
		expect(clipA.chunks).toEqual([]);
		expect(clipB.chunks).toEqual([[2, 0]]);
	});

	it('socket closes mid-clip → the clip rejects, the next clip reconnects', async () => {
		let closed = false;
		const { fake, tts } = setup((peer, frame) => {
			if (!frame.text_end) {
				return;
			}

			if (!closed) {
				closed = true;

				peer.close();

				return;
			}

			peer.send(JSON.stringify({ stream_id: frame.stream_id, terminated: true }));
		});
		await expect(startClip(tts, 's1').done).rejects.toThrow('socket closed');
		await startClip(tts, 's2').done;
		expect(fake.peers).toHaveLength(2);
	});

	it('connection-level error (no stream_id) → open clips reject at once, the next clip reconnects', async () => {
		let failed = false;
		const { fake, tts } = setup((peer, frame) => {
			if (!frame.text_end) {
				return;
			}

			if (!failed) {
				failed = true;

				peer.send(JSON.stringify({ error_code: 401, error_message: 'Invalid API key' }));

				return;
			}

			peer.send(JSON.stringify({ stream_id: frame.stream_id, terminated: true }));
		});
		const started = Date.now();
		await expect(startClip(tts, 's1').done).rejects.toThrow('error 401');
		expect(Date.now() - started).toBeLessThan(1000);
		await startClip(tts, 's2').done;
		expect(fake.peers).toHaveLength(2);
	});

	it('unreachable → the clip rejects', async () => {
		const tts = new SonioxTts({ apiKey: 'k', url: 'ws://localhost:1' });
		await expect(startClip(tts, 's1').done).rejects.toThrow('could not reach Soniox TTS');
	});

	it('idle → keepalive sent; after the socket closes, no more keepalives', async () => {
		const { fake, tts } = setup(undefined, 20);
		await startClip(tts, 's1').done;
		await waitUntil(() => fake.frames.some((frame) => frame.keep_alive === true));

		fake.peers[0]?.close();
		await Bun.sleep(30);
		const count = fake.frames.filter((frame) => frame.keep_alive).length;
		await Bun.sleep(80);
		expect(fake.frames.filter((frame) => frame.keep_alive).length).toBe(count);
	});

	it('already aborted → nothing sent', async () => {
		const { fake, tts } = setup();
		const abort = new AbortController();
		abort.abort();
		await startClip(tts, 's1', 'x', abort.signal).done;
		expect(fake.frames).toEqual([]);
	});
});

describe('computePcmSeconds', () => {
	it('24 kHz 16-bit mono → 48000 bytes a second', () => expect(computePcmSeconds(96_000)).toBe(2));
});
