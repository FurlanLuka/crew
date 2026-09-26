import { useEffect, useMemo } from 'react';
import { SPEECH_SAMPLE_RATE, type SpeechMessage } from '../shared/protocol.js';
import { base64ToBytes, createChimeSamples, pcmToFloat } from './pcm.js';

interface Clip {
	id: string;
	sources: Set<AudioBufferSourceNode>;
	carry: number | null;
	hasEnded: boolean;
}

type ClipDoneListener = (id: string) => void;

export class PcmPlayer {
	private context: AudioContext | null = null;
	private nextStart = 0;
	private clips = new Map<string, Clip>();
	private audibleUntil = 0;
	private notify: ClipDoneListener = () => {
		// Nothing listens until setNotify is called.
	};
	private chime: Float32Array | null = null;

	setNotify(listener: ClipDoneListener): void {
		this.notify = listener;
	}

	resume(): void {
		// Browsers keep audio suspended until the page gets a gesture.
		void this.getAudioContext()
			.resume()
			.catch(() => {
				// Still suspended: the next gesture tries again.
			});
	}

	receive(message: SpeechMessage): void {
		if (message.type === 'audio_cancel') {
			this.cancel(message.id);

			return;
		}

		const clip = this.clips.get(message.id) ?? this.open(message.id);

		// Part of the clip: cutting the clip cuts its chime too.
		if (message.hasChime) {
			this.chime ??= createChimeSamples(SPEECH_SAMPLE_RATE);
			this.play(clip, this.chime);
		}

		if (message.base64) {
			this.schedule(clip, base64ToBytes(message.base64));
		}

		if (message.isLast) {
			clip.hasEnded = true;
			this.settle(clip);
		}
	}

	stop(): void {
		for (const id of [...this.clips.keys()]) {
			this.cancel(id);
		}
	}

	isAudibleWithin(ms: number): boolean {
		// The mic asks, so a press right after speech does not send that speech as pre-roll.
		return performance.now() - this.audibleUntil < ms;
	}

	private getAudioContext(): AudioContext {
		this.context ??= new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });

		return this.context;
	}

	private open(id: string): Clip {
		const clip: Clip = { id, sources: new Set(), carry: null, hasEnded: false };
		this.clips.set(id, clip);
		console.debug('[speech] clip start', id);

		return clip;
	}

	private schedule(clip: Clip, bytes: Uint8Array): void {
		const { samples, carry } = pcmToFloat(bytes, clip.carry);
		clip.carry = carry;

		if (samples.length > 0) {
			this.play(clip, samples);
		}
	}

	private play(clip: Clip, samples: Float32Array): void {
		const context = this.getAudioContext();
		const buffer = context.createBuffer(1, samples.length, SPEECH_SAMPLE_RATE);
		buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(context.destination);
		// Right after the previous chunk, so a clip plays without gaps.
		const startAt = Math.max(context.currentTime, this.nextStart);
		source.start(startAt);
		this.nextStart = startAt + buffer.duration;
		this.audibleUntil = Math.max(
			this.audibleUntil,
			performance.now() + (this.nextStart - context.currentTime) * 1000,
		);
		clip.sources.add(source);

		source.onended = () => {
			clip.sources.delete(source);
			this.settle(clip);
		};
	}

	private settle(clip: Clip): void {
		// audio_done goes back only once the last chunk has actually finished playing.
		if (!clip.hasEnded || clip.sources.size > 0 || this.clips.get(clip.id) !== clip) {
			return;
		}

		this.clips.delete(clip.id);
		console.debug('[speech] clip done', clip.id);
		this.notify(clip.id);
	}

	private cancel(id: string): void {
		const clip = this.clips.get(id);

		if (!clip) {
			return;
		}

		// A cut clip never reports done.
		this.clips.delete(id);

		for (const source of clip.sources) {
			source.stop();
		}

		clip.sources.clear();
		this.audibleUntil = Math.min(this.audibleUntil, performance.now());
		// What comes next plays at once, not after the audio that was already scheduled.
		this.nextStart = this.context?.currentTime ?? 0;
		console.debug('[speech] clip cancelled', id);
	}
}

export const useSpeechPlayer = (): PcmPlayer => {
	const player = useMemo(() => new PcmPlayer(), []);

	useEffect(() => {
		const resumePlayer = () => player.resume();
		window.addEventListener('pointerdown', resumePlayer);
		window.addEventListener('keydown', resumePlayer);

		return () => {
			window.removeEventListener('pointerdown', resumePlayer);
			window.removeEventListener('keydown', resumePlayer);
		};
	}, [player]);

	return player;
};
