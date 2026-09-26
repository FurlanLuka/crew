import { createLogger } from '../log.js';
import { SPEECH_SAMPLE_RATE } from '../shared/protocol.js';

export interface SynthesizeParams {
	id: string;
	text: string;
	onAudio: (pcm: Uint8Array) => void;
	signal: AbortSignal;
}

export type Synthesize = (params: SynthesizeParams) => Promise<void>;

export interface SonioxTtsOptions {
	apiKey: string;
	voice?: string;
	url?: string;
	keepAliveMs?: number;
}

interface SonioxTtsMessage {
	stream_id?: string;
	audio?: string;
	terminated?: boolean;
	error_code?: number;
	error_message?: string;
}

interface Clip {
	onAudio: (pcm: Uint8Array) => void;
	resolve: () => void;
	reject: (error: Error) => void;
	startedAt: number;
	firstChunkMs: number | null;
	bytes: number;
}

const log = createLogger('tts');
export const TTS_URL = 'wss://tts-rt.soniox.com/tts-websocket';
export const TTS_MODEL = 'tts-rt-v2';
export const TTS_VOICE = 'Isla';
export const TTS_SPEED = 1.15;
const KEEP_ALIVE_MS = 20_000;

const parseMessage = (data: unknown): SonioxTtsMessage | undefined => {
	try {
		return JSON.parse(String(data)) as SonioxTtsMessage;
	} catch {
		// Not JSON: the caller logs the frame and skips it.
		return undefined;
	}
};

export const computePcmSeconds = (bytes: number): number => {
	// 16-bit mono PCM: two bytes per sample.
	return bytes / (SPEECH_SAMPLE_RATE * 2);
};

export class SonioxTts {
	private connection: Promise<WebSocket> | null = null;
	private currentSocket: WebSocket | null = null;
	private clips = new Map<string, Clip>();
	private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private options: SonioxTtsOptions) {}

	synthesize: Synthesize = async ({ id, text, onAudio, signal }) => {
		if (signal.aborted) {
			return;
		}

		const socket = await this.connect();

		if (signal.aborted) {
			return;
		}

		await new Promise<void>((resolve, reject) => {
			this.clips.set(id, {
				onAudio,
				resolve,
				reject,
				startedAt: Date.now(),
				firstChunkMs: null,
				bytes: 0,
			});
			signal.addEventListener('abort', () => this.cancel(id), { once: true });
			socket.send(
				JSON.stringify({
					api_key: this.options.apiKey,
					model: TTS_MODEL,
					language: 'en',
					// Bright and friendly, a little quicker than Soniox's default pace.
					voice: this.options.voice ?? TTS_VOICE,
					speed: TTS_SPEED,
					audio_format: 'pcm_s16le',
					sample_rate: SPEECH_SAMPLE_RATE,
					stream_id: id,
				}),
			);
			socket.send(JSON.stringify({ text, text_end: true, stream_id: id }));
		});
	};

	close(): void {
		this.stopKeepAlive();
		this.currentSocket?.close();
	}

	private cancel(id: string): void {
		const clip = this.clips.get(id);

		if (!clip) {
			return;
		}

		// A cancelled clip settles at once; chunks Soniox still sends for it are dropped.
		this.clips.delete(id);
		log.info('clip cancelled', { id, bytes: clip.bytes });
		void this.connection
			?.then((socket) => {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ stream_id: id, cancel: true }));
				}
			})
			.catch(() => {
				// The socket never opened: Soniox has nothing to cancel.
			});
		clip.resolve();
	}

	private connect(): Promise<WebSocket> {
		if (this.connection) {
			return this.connection;
		}

		// One socket for every clip, so a clip after the first skips the ~400 ms handshake.
		const startedAt = Date.now();
		const socket = new WebSocket(this.options.url ?? TTS_URL);
		this.currentSocket = socket;
		this.connection = new Promise((resolve, reject) => {
			socket.onopen = () => {
				log.info('connected', { ms: Date.now() - startedAt });
				this.startKeepAlive(socket);
				resolve(socket);
			};

			socket.onerror = () => reject(new Error('could not reach Soniox TTS'));
		});
		this.connection.catch(() => this.dropSocket(socket, 'connect failed'));
		socket.onmessage = (event) => this.handleMessage(socket, event.data);
		socket.onclose = () => this.dropSocket(socket, 'closed');

		return this.connection;
	}

	private handleMessage(socket: WebSocket, data: unknown): void {
		const message = parseMessage(data);

		if (message === undefined) {
			log.warn('unreadable frame from Soniox TTS', { bytes: String(data).length });

			return;
		}

		const id = message.stream_id ?? '';
		const clip = this.clips.get(id);

		if (message.error_code) {
			log.warn('clip failed', { id, code: message.error_code, error: message.error_message });

			// An error for no open clip is about the connection (bad key, quota): fail everything now.
			if (!clip) {
				this.dropSocket(socket, `error ${message.error_code}`);

				return;
			}

			this.clips.delete(id);
			clip.reject(new Error(`Soniox TTS ${message.error_code}: ${message.error_message ?? ''}`));

			return;
		}

		if (!clip) {
			return;
		}

		if (message.audio) {
			const pcm = Buffer.from(message.audio, 'base64');

			if (clip.firstChunkMs === null) {
				clip.firstChunkMs = Date.now() - clip.startedAt;
			}

			clip.bytes += pcm.byteLength;
			clip.onAudio(new Uint8Array(pcm));
		}

		if (message.terminated) {
			this.clips.delete(id);
			log.info('synthesized', {
				id,
				firstChunkMs: clip.firstChunkMs,
				ms: Date.now() - clip.startedAt,
				bytes: clip.bytes,
			});
			clip.resolve();
		}
	}

	private dropSocket(socket: WebSocket, reason: string): void {
		if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
			socket.close();
		}

		// A late close of a socket already replaced must not touch the new one.
		if (this.currentSocket !== socket) {
			return;
		}

		this.currentSocket = null;
		this.connection = null;
		this.stopKeepAlive();

		if (this.clips.size) {
			log.warn('socket lost with clips open', { reason, open: this.clips.size });
		} else {
			log.info('socket closed', { reason });
		}

		// Every clip still open on a dead socket fails now instead of waiting on a timer.
		for (const clip of this.clips.values()) {
			clip.reject(new Error(`Soniox TTS socket ${reason}`));
		}

		this.clips.clear();
	}

	private startKeepAlive(socket: WebSocket): void {
		this.stopKeepAlive();
		this.keepAliveTimer = setInterval(() => {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ keep_alive: true }));
			}
		}, this.options.keepAliveMs ?? KEEP_ALIVE_MS);
	}

	private stopKeepAlive(): void {
		if (this.keepAliveTimer) {
			clearInterval(this.keepAliveTimer);
		}

		this.keepAliveTimer = null;
	}
}
