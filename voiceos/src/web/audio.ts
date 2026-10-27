import { clientLog, describeError } from './client-log.js';
import { PttBuffer, type PressParams } from './ptt.js';

const WORKLET_SOURCE = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = []; this.size = 0; this.frame = Math.round(sampleRate / 10) }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    const out = new Int16Array(channel.length)
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]))
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    this.buffer.push(out); this.size += out.length
    if (this.size >= this.frame) {
      const merged = new Int16Array(this.size)
      let offset = 0
      for (const part of this.buffer) { merged.set(part, offset); offset += part.length }
      this.port.postMessage(merged.buffer, [merged.buffer])
      this.buffer = []; this.size = 0
    }
    return true
  }
}
registerProcessor('pcm16', Pcm16)
`;

export interface MicEvents {
	onAudio: (chunk: ArrayBuffer) => void;
	onStop: () => void;
}

export type MicMode = 'raw' | 'handsFree';

interface Device {
	stream: MediaStream;
	context: AudioContext;
}

export class Mic {
	private buffer: PttBuffer | null = null;
	private opening: Promise<number> | null = null;
	private device: Device | null = null;
	private mode: MicMode = 'raw';
	private generation = 0;

	constructor(private events: MicEvents) {}

	ensure(mode: MicMode = 'raw'): Promise<number> {
		if (this.opening && this.mode !== mode) {
			this.close();
		}

		this.mode = mode;

		if (!this.opening) {
			clientLog('info', 'mic', 'ensure start', { mode });
			this.opening = this.open(mode).then(
				(sampleRate) => {
					clientLog('info', 'mic', 'ensure open', { mode, sampleRate });

					return sampleRate;
				},
				(error: unknown) => {
					clientLog('warn', 'mic', 'ensure failed', { mode, ...describeError(error) });
					this.opening = null;
					throw error;
				},
			);
		}

		return this.opening;
	}

	// iOS starts audio only from a gesture: each press and release nudges a suspended device awake.
	wake(): void {
		const context = this.device?.context;

		if (context?.state === 'suspended') {
			void context.resume().catch(() => {
				// Still suspended: the next gesture tries again.
			});
		}
	}

	listen(begin: () => void): void {
		if (!this.buffer) {
			return;
		}

		if (this.buffer.listen().shouldStopFirst) {
			this.events.onStop();
		}

		begin();
	}

	unlisten(): void {
		this.buffer?.unlisten();
	}

	close(): void {
		// An open still in flight sees the new generation and releases its device.
		this.generation++;
		this.opening = null;
		this.buffer = null;

		if (this.device) {
			releaseDevice(this.device);
		}

		this.device = null;
	}

	press(begin: () => void, { withPreRoll = true }: PressParams = {}): void {
		if (!this.buffer) {
			return;
		}

		// Stop, announce, then pre-roll, in that order, so no audio lands in the wrong utterance.
		const { preRoll, shouldStopFirst } = this.buffer.press({ withPreRoll });

		if (shouldStopFirst) {
			this.events.onStop();
		}

		begin();

		for (const chunk of preRoll) {
			this.events.onAudio(copyChunk(chunk));
		}
	}

	release(): void {
		this.buffer?.release();
	}

	// Not async on purpose: getUserMedia and the AudioContext must start in the caller's own turn,
	// inside the press, before anything awaits — iOS asks for the mic and starts audio only from a
	// gesture, and a press that awaited first is no longer one.
	private open(mode: MicMode): Promise<number> {
		const generation = this.generation;

		if (!navigator.mediaDevices?.getUserMedia) {
			return Promise.reject(
				new Error('microphone needs a secure origin (open the localhost or https link)'),
			);
		}

		// Raw like Soniox's own SDK: call processing smears consonants; hands-free needs echo cancelling.
		const echoCancellation = mode === 'handsFree';
		const streaming = navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation, noiseSuppression: false, autoGainControl: false },
		});
		// The device's own rate and ~100 ms frames: browser resampling is where quality went.
		const context = new AudioContext();

		void context.resume().catch(() => {
			// Resumed by the next press (wake).
		});

		return this.connect(streaming, context, generation, mode);
	}

	private async connect(
		streaming: Promise<MediaStream>,
		context: AudioContext,
		generation: number,
		mode: MicMode,
	): Promise<number> {
		let stream: MediaStream;

		try {
			stream = await streaming;
		} catch (error) {
			void context.close();
			throw error;
		}

		const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));

		try {
			await context.audioWorklet.addModule(url);
		} catch (error) {
			releaseDevice({ stream, context });
			throw error;
		} finally {
			URL.revokeObjectURL(url);
		}

		if (generation !== this.generation) {
			releaseDevice({ stream, context });
			throw new Error('microphone closed while opening');
		}

		this.device = { stream, context };

		const source = context.createMediaStreamSource(stream);
		const node = new AudioWorkletNode(context, 'pcm16');
		const buffer = new PttBuffer(context.sampleRate);

		node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
			const { send, shouldStop } = buffer.push(new Int16Array(event.data));

			for (const chunk of send) {
				this.events.onAudio(copyChunk(chunk));
			}

			if (shouldStop) {
				this.events.onStop();
			}
		};

		source.connect(node);
		this.buffer = buffer;
		console.info('[mic] open', { sampleRate: context.sampleRate, mode });

		return context.sampleRate;
	}
}

const releaseDevice = ({ stream, context }: Device): void => {
	for (const track of stream.getTracks()) {
		track.stop();
	}

	void context.close();
};

const copyChunk = (chunk: Int16Array): ArrayBuffer =>
	chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;

export const isMicAllowed = async (): Promise<boolean> => {
	try {
		const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });

		return permission.state === 'granted';
	} catch {
		return false;
	}
};
