import { createLogger } from '../log.js';
import { TranscriptAccumulator, type SonioxToken } from './tokens.js';

interface SonioxResponse {
	tokens?: SonioxToken[];
	finished?: boolean;
	error_code?: number;
	error_message?: string;
}

export type SttFailure = 'soniox' | 'connection';

export interface SttSessionOptions {
	apiKey: string;
	terms: string[];
	onPartial: (text: string) => void;
	onFinal: (text: string) => void;
	// soniox: refused (bad key or config), a retry repeats it; connection: a new stream may work.
	onError: (message: string, cause: SttFailure) => void;
	// Hands-free: Soniox ends each turn and keeps the stream open; every finished turn comes here.
	onSegment?: (text: string) => void;
	// The browser's native rate: resampling in the browser is where quality went.
	sampleRate?: number;
	url?: string;
	finalizeTimeoutMs?: number;
}

export type SttHandle = Pick<SttSession, 'send' | 'end' | 'cancel'>;

const log = createLogger('stt');
export const STT_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
export const STT_MODEL = 'stt-rt-v5';

const FINALIZE_TIMEOUT_MS = 3000;
const MAX_ENDPOINT_DELAY_MS = 1500;
export const DEFAULT_SAMPLE_RATE_HZ = 16000;

const parseResponse = (data: unknown): SonioxResponse | undefined => {
	try {
		return JSON.parse(String(data)) as SonioxResponse;
	} catch {
		// Not JSON: the caller logs the frame and skips it.
		return undefined;
	}
};

export class SttSession {
	private socket: WebSocket;
	private opened: Promise<void>;
	private transcript: TranscriptAccumulator;
	private isDone = false;
	private bufferedChunks: Uint8Array<ArrayBuffer>[] = [];
	private isReady = false;
	private startedAt = Date.now();
	private firstPartialMs: number | null = null;
	private endedAt: number | null = null;
	private audioBytes = 0;
	private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
	private sampleRate: number;
	private finalizeTimeoutMs: number;

	constructor(private options: SttSessionOptions) {
		// The audio fixtures' rate; the browser sends its own.
		this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE_HZ;
		this.finalizeTimeoutMs = options.finalizeTimeoutMs ?? FINALIZE_TIMEOUT_MS;
		const isSegmented = Boolean(options.onSegment);
		this.transcript = new TranscriptAccumulator({ isSegmented });
		this.socket = new WebSocket(options.url ?? STT_URL);
		this.socket.binaryType = 'arraybuffer';
		this.opened = new Promise((resolve, reject) => {
			this.socket.onopen = () => {
				this.socket.send(
					JSON.stringify({
						api_key: options.apiKey,
						model: STT_MODEL,
						audio_format: 'pcm_s16le',
						sample_rate: this.sampleRate,
						num_channels: 1,
						// Without a hint the model spends its first words deciding the language.
						language_hints: ['en'],
						enable_endpoint_detection: isSegmented,
						...(isSegmented ? { max_endpoint_delay_ms: MAX_ENDPOINT_DELAY_MS } : {}),
						context: { terms: options.terms },
					}),
				);
				this.isReady = true;

				for (const chunk of this.bufferedChunks) {
					this.socket.send(chunk);
				}

				this.bufferedChunks = [];
				resolve();
			};

			this.socket.onerror = () => reject(new Error('could not reach Soniox'));
		});
		this.opened.catch((error: unknown) => this.fail(String(error), 'connection'));

		this.socket.onmessage = (event) => {
			const response = parseResponse(event.data);

			if (response === undefined) {
				log.warn('unreadable frame from Soniox', { bytes: String(event.data).length });

				return;
			}

			if (response.error_code) {
				this.fail(`Soniox ${response.error_code}: ${response.error_message ?? ''}`, 'soniox');

				return;
			}

			if (response.tokens?.length) {
				const { isFinished, segments } = this.transcript.push(response.tokens);

				if (this.firstPartialMs === null && this.transcript.text) {
					this.firstPartialMs = Date.now() - this.startedAt;
				}

				if (isFinished) {
					this.finish('fin');

					return;
				}

				for (const segment of segments) {
					log.info('turn ended', { text: segment });
					this.options.onSegment?.(segment);
				}

				this.options.onPartial(this.transcript.text);
			}

			if (response.finished) {
				this.finish('finished');
			}
		};

		this.socket.onclose = () => {
			// A close before the socket ever opened is a failed connection, not an empty utterance.
			if (!this.isReady) {
				this.fail('could not reach Soniox', 'connection');

				return;
			}

			this.finish('closed');
		};
	}

	send(input: Uint8Array): void {
		// After release the stream is finalizing; later audio belongs to the next press.
		if (this.isDone || this.endedAt !== null) {
			return;
		}

		// Copy onto a plain ArrayBuffer: the socket frame may be a view over a shared buffer.
		const chunk = new Uint8Array(input);
		this.audioBytes += chunk.byteLength;

		if (!this.isReady) {
			this.bufferedChunks.push(chunk);

			return;
		}

		this.socket.send(chunk);
	}

	async end(): Promise<void> {
		this.endedAt = Date.now();

		try {
			await this.opened;
		} catch {
			// The failed open already reported the error.
			return;
		}

		if (this.isDone || this.socket.readyState !== WebSocket.OPEN) {
			return;
		}

		// Finalize rather than close: Soniox answers within a few hundred ms, a close took seconds.
		this.socket.send(JSON.stringify({ type: 'finalize' }));
		this.finalizeTimer = setTimeout(() => {
			log.warn('finalize timed out, closing the stream', { ms: this.finalizeTimeoutMs });

			// An empty frame ends the stream; Bun drops zero-length binary frames, so it is text.
			if (this.socket.readyState === WebSocket.OPEN) {
				this.socket.send('');
			}

			// Still unanswered: fail, since later speech is routed in press order behind it.
			this.finalizeTimer = setTimeout(
				() => this.fail('Soniox did not finish the transcript in time', 'connection'),
				this.finalizeTimeoutMs,
			);
		}, this.finalizeTimeoutMs);
	}

	cancel(): void {
		this.isDone = true;
		this.clearFinalizeTimer();
		this.socket.close();
	}

	private clearFinalizeTimer(): void {
		if (this.finalizeTimer) {
			clearTimeout(this.finalizeTimer);
		}

		this.finalizeTimer = null;
	}

	private finish(via: 'fin' | 'finished' | 'closed'): void {
		if (this.isDone) {
			return;
		}

		this.isDone = true;
		this.clearFinalizeTimer();
		const text = this.transcript.finalText || this.transcript.text;
		log.info('final transcript', {
			via,
			text,
			audioSeconds: Math.round((this.audioBytes / 2 / this.sampleRate) * 100) / 100,
			sampleRate: this.sampleRate,
			firstPartialMs: this.firstPartialMs,
			finalizeMs: this.endedAt === null ? null : Date.now() - this.endedAt,
		});
		this.options.onFinal(text);

		if (this.socket.readyState === WebSocket.OPEN) {
			this.socket.send('');
			this.socket.close();
		}
	}

	private fail(message: string, cause: SttFailure): void {
		if (this.isDone) {
			return;
		}

		this.isDone = true;
		this.clearFinalizeTimer();
		log.error('stt failed', { error: message, cause });
		this.options.onError(message, cause);
		this.socket.close();
	}
}
