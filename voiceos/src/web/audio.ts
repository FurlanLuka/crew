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
		this.opening ??= this.open(mode).catch((error: unknown) => {
			this.opening = null;
			throw error;
		});

		return this.opening;
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

	private async open(mode: MicMode): Promise<number> {
		const generation = this.generation;

		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error('microphone needs a secure origin (open the localhost or https link)');
		}

		// Raw like Soniox's own SDK: call processing smears consonants; hands-free needs echo cancelling.
		const echoCancellation = mode === 'handsFree';
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation, noiseSuppression: false, autoGainControl: false },
		});
		// The device's own rate and ~100 ms frames: browser resampling is where quality went.
		const context = new AudioContext();
		const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
		await context.audioWorklet.addModule(url);
		URL.revokeObjectURL(url);

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
