import { useEffect, useMemo } from 'react';
import { SPEECH_SAMPLE_RATE, type SpeechMessage } from '../shared/protocol.js';
import { applyAudioSession } from './audio-session.js';
import { clientLog, describeError } from './client-log.js';
import { base64ToBytes, createChimeSamples, type ChimeKind, pcmToFloat } from './pcm.js';
import { IS_PHONE } from './phone.js';

interface Clip {
	id: string;
	sources: Set<AudioBufferSourceNode>;
	carry: number | null;
	hasEnded: boolean;
}

type ClipDoneListener = (id: string) => void;

type CreateContext = () => AudioContext;

const createSpeechContext: CreateContext = () =>
	new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });

// After a lock or a call iOS leaves the context "interrupted" (not in the DOM's types), else
// "suspended"; either way nothing scheduled on it is heard.
const isRunning = (context: AudioContext): boolean => context.state === 'running';

const isPageHidden = (): boolean =>
	typeof document !== 'undefined' && document.visibilityState === 'hidden';

export class PcmPlayer {
	private context: AudioContext | null = null;
	private nextStart = 0;
	private clips = new Map<string, Clip>();
	private audibleUntil = 0;
	private notify: ClipDoneListener = () => {
		// Nothing listens until setNotify is called.
	};
	private chimes = new Map<ChimeKind, Float32Array>();
	private isMuted = false;
	private cutIds = new Set<string>();

	constructor(
		private createContext: CreateContext = createSpeechContext,
		private isPhone = IS_PHONE,
	) {}

	setNotify(listener: ClipDoneListener): void {
		this.notify = listener;
	}

	setMuted(isMuted: boolean): void {
		this.isMuted = isMuted;

		if (isMuted) {
			this.stop();
		}
	}

	// A gesture: browsers start audio only from one. A context a gesture cannot start is stuck (iOS,
	// after some interruptions) and is made again; the next clip plays on the new one.
	resume(): void {
		applyAudioSession(this.isPhone);
		const context = this.getAudioContext();

		if (isRunning(context)) {
			return;
		}

		void context
			.resume()
			.catch((error: unknown) => {
				clientLog('warn', 'speech', 'resume failed', {
					state: context.state,
					...describeError(error),
				});
			})
			.then(() => {
				if (this.context === context && !isRunning(context) && !isPageHidden()) {
					this.recreate(context);
				}
			});
	}

	// Back on screen, or a clip came while the context wasn't running: try without a gesture, which
	// iOS allows for a context it interrupted itself.
	wake(): void {
		const context = this.context;

		if (!context || isRunning(context)) {
			return;
		}

		void context.resume().catch(() => {
			// Not without a gesture: the next tap tries again.
		});
	}

	receive(message: SpeechMessage): void {
		if (message.type === 'audio_cancel') {
			this.cutIds.delete(message.id);
			this.cancel(message.id);

			return;
		}

		// The rest of a clip cut when its context was remade: the server still sends it, nobody hears it.
		if (this.cutIds.has(message.id)) {
			if (message.isLast) {
				this.cutIds.delete(message.id);
			}

			return;
		}

		// Muted: nothing plays and nothing is reported. Another tab may be playing it, and the server
		// times a clip nobody reports on by its own length.
		if (this.isMuted) {
			return;
		}

		const clip = this.clips.get(message.id) ?? this.open(message.id);

		// Part of the clip: cutting the clip cuts its chime too.
		if (message.hasChime) {
			const kind: ChimeKind = message.chime ?? 'plain';
			const samples = this.chimes.get(kind) ?? createChimeSamples(SPEECH_SAMPLE_RATE, kind);
			this.chimes.set(kind, samples);
			this.play(clip, samples);
		}

		if (message.base64) {
			this.schedule(clip, base64ToBytes(message.base64));
		}

		if (message.isLast) {
			clip.hasEnded = true;
			this.settle(clip);
		}
	}

	// A chime of its own (the call was heard), not part of a clip the server waits on.
	playChime(): void {
		if (this.isMuted) {
			return;
		}

		const context = this.getAudioContext();
		const samples = this.chimes.get('plain') ?? createChimeSamples(SPEECH_SAMPLE_RATE, 'plain');
		this.chimes.set('plain', samples);
		const buffer = context.createBuffer(1, samples.length, SPEECH_SAMPLE_RATE);
		buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(context.destination);
		source.start(context.currentTime);
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
		if (!this.context) {
			const context = this.createContext();

			context.onstatechange = () => {
				clientLog('info', 'speech', 'context state', {
					state: context.state,
					hidden: isPageHidden(),
				});
			};

			this.context = context;
		}

		return this.context;
	}

	// Once per clip: a clip that cannot be heard says so in the log, and nudges the context awake.
	private checkRunning(id: string): void {
		const context = this.getAudioContext();

		// A desktop plays in a hidden tab; a phone's page is suspended there.
		if (isRunning(context) && (!this.isPhone || !isPageHidden())) {
			return;
		}

		clientLog('warn', 'speech', 'clip while silent', {
			id,
			state: context.state,
			hidden: isPageHidden(),
		});
		this.wake();
	}

	private recreate(old: AudioContext): void {
		clientLog('warn', 'speech', 'context recreated', { state: old.state });

		// Its clips were never heard: cut, so none reports done for audio nobody played, and their
		// remaining chunks are dropped as they come.
		for (const clip of this.clips.values()) {
			if (!clip.hasEnded) {
				this.cutIds.add(clip.id);
			}
		}

		this.stop();
		this.context = null;
		this.nextStart = 0;
		old.onstatechange = null;
		void old.close().catch(() => {
			// Already closed.
		});
		this.getAudioContext()
			.resume()
			.catch(() => {
				// The next gesture tries again.
			});
	}

	private open(id: string): Clip {
		const clip: Clip = {
			id,
			sources: new Set(),
			carry: null,
			hasEnded: false,
		};
		this.clips.set(id, clip);
		console.debug('[speech] clip start', id);
		this.checkRunning(id);

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

		const wakePlayer = () => {
			if (document.visibilityState === 'visible') {
				player.wake();
			}
		};

		window.addEventListener('pointerdown', resumePlayer);
		window.addEventListener('keydown', resumePlayer);
		document.addEventListener('visibilitychange', wakePlayer);
		window.addEventListener('pageshow', wakePlayer);

		return () => {
			window.removeEventListener('pointerdown', resumePlayer);
			window.removeEventListener('keydown', resumePlayer);
			document.removeEventListener('visibilitychange', wakePlayer);
			window.removeEventListener('pageshow', wakePlayer);
		};
	}, [player]);

	return player;
};
