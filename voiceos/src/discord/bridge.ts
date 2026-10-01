// Discord as one more Voice OS client: the owner's voice in, Voice OS's speech out. What only Discord
// knows (connecting, voice states, packets) is behind VoiceLink, so this part is tested without it.
import { createLogger } from '../log.js';
import {
	SPEECH_SAMPLE_RATE,
	type ListeningMode,
	type ServerMessage,
	type SpeechMessage,
} from '../shared/protocol.js';
import { TURNED_OFF_BY_VOICE } from '../speech/hands-free-switch.js';
import { createChimeSamples } from '../web/pcm.js';
import { FRAME_SAMPLES, FrameSplitter, toDiscordStereo, toMono } from './audio.js';
import type { OpusCodec } from './codec.js';

const log = createLogger('discord');

export const DISCORD_CLIENT = 'discord';

// Discord sends nothing while the owner is quiet; speech-to-text needs the silence to hear a turn end.
export const SILENCE_AFTER_MS = 60;
const SILENCE_TICK_MS = 20;
const MONO_SILENCE = new Uint8Array(FRAME_SAMPLES * 2);

export interface VoiceLinkEvents {
	onConnected: (isConnected: boolean, error?: string) => void;
	onOwner: (isIn: boolean) => void;
	// Only the owner's packets ever arrive: the link subscribes to no one else.
	onOwnerPacket: (packet: Uint8Array) => void;
	onPlaybackIdle: () => void;
}

export interface VoiceLink {
	startClip: () => ClipSink;
	stopPlayback: () => void;
	close: () => void;
}

export interface ClipSink {
	push: (packet: Uint8Array) => void;
	end: () => void;
}

export interface DiscordBridgeOptions {
	codec: OpusCodec;
	// The owner's voice, mono at DISCORD_SAMPLE_RATE, for VoiceInput.
	onAudio: (mono: Uint8Array) => void;
	onOwner: (isIn: boolean) => void;
	onConnected: (isConnected: boolean, error?: string) => void;
	onClipDone: (id: string) => void;
	onMode: (mode: ListeningMode) => void;
	// Listening stopped on its own (speech-to-text gave up): the developer is in the channel, unheard.
	onListenOff: (reason: string) => void;
	setTimer?: (run: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	now?: () => number;
}

interface Playing {
	id: string;
	sink: ClipSink;
	splitter: FrameSplitter;
	hasEnded: boolean;
}

const toInt16 = (samples: Float32Array): Uint8Array => {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);

	for (const [index, sample] of samples.entries()) {
		view.setInt16(
			index * 2,
			Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767))),
			true,
		);
	}

	return bytes;
};

export class DiscordBridge {
	private link: VoiceLink | null = null;
	private playing: Playing | null = null;
	private isOwnerIn = false;
	private lastPacketAt = 0;
	private silenceTimer: unknown = null;
	// A run of undecodable packets (E2EE still settling) is logged once, not 50 times a second.
	private decodeFailures = 0;
	private now: () => number;
	private setTimer: (run: () => void, ms: number) => unknown;
	private clearTimer: (timer: unknown) => void;

	constructor(private options: DiscordBridgeOptions) {
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? ((run, ms) => setInterval(run, ms));
		this.clearTimer =
			options.clearTimer ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
	}

	// The events a VoiceLink reports; given to it when it connects.
	readonly events: VoiceLinkEvents = {
		onConnected: (isConnected, error) => {
			log.info(isConnected ? 'connected' : 'disconnected', error ? { error } : {});
			this.options.onConnected(isConnected, error);

			if (!isConnected) {
				this.ownerLeft();
			}
		},
		onOwner: (isIn) => (isIn ? this.ownerJoined() : this.ownerLeft()),
		onOwnerPacket: (packet) => this.hear(packet),
		onPlaybackIdle: () => this.playbackIdle(),
	};

	attach(link: VoiceLink): void {
		this.link = link;
	}

	detach(): void {
		this.ownerLeft();
		this.link?.close();
		this.link = null;
	}

	get ownerIsIn(): boolean {
		return this.isOwnerIn;
	}

	// What Voice OS sends a client; true when Discord took it.
	send(message: ServerMessage): boolean {
		switch (message.type) {
			case 'audio':
				return this.playChunk(message);
			case 'audio_cancel':
				this.cancel(message.id);

				return true;
			case 'listen_on':
				this.options.onMode(message.mode);

				return true;
			case 'listen_off':
				// Push to talk has no meaning in a voice channel: refused, so the voice switch says so.
				if (message.reason === TURNED_OFF_BY_VOICE) {
					return false;
				}

				this.options.onListenOff(message.reason);

				return true;
			default:
				return false;
		}
	}

	private ownerJoined(): void {
		if (this.isOwnerIn) {
			return;
		}

		this.isOwnerIn = true;
		this.lastPacketAt = this.now();
		this.silenceTimer = this.setTimer(() => this.fillSilence(), SILENCE_TICK_MS);
		log.info('owner joined');
		this.options.onOwner(true);
	}

	private ownerLeft(): void {
		if (!this.isOwnerIn) {
			return;
		}

		this.isOwnerIn = false;
		this.clearTimer(this.silenceTimer);
		this.silenceTimer = null;
		log.info('owner left');
		this.options.onOwner(false);
	}

	private hear(packet: Uint8Array): void {
		if (!this.isOwnerIn) {
			return;
		}

		this.lastPacketAt = this.now();

		let decoded: Uint8Array;

		try {
			decoded = this.options.codec.decode(packet);
		} catch (error) {
			this.decodeFailures++;

			if (this.decodeFailures === 1) {
				log.warn('packet not decoded', { error: String(error) });
			}

			return;
		}

		if (this.decodeFailures > 0) {
			log.info('packets decoded again', { skipped: this.decodeFailures });
			this.decodeFailures = 0;
		}

		this.options.onAudio(toMono(decoded));
	}

	private fillSilence(): void {
		if (this.isOwnerIn && this.now() - this.lastPacketAt >= SILENCE_AFTER_MS) {
			this.options.onAudio(MONO_SILENCE);
		}
	}

	private playChunk(message: Extract<SpeechMessage, { type: 'audio' }>): boolean {
		if (!this.link || !this.isOwnerIn) {
			return false;
		}

		if (this.playing?.id !== message.id) {
			this.playing?.sink.end();
			this.playing = {
				id: message.id,
				sink: this.link.startClip(),
				splitter: new FrameSplitter(),
				hasEnded: false,
			};

			if (message.hasChime) {
				this.encodeInto(
					this.playing,
					toInt16(createChimeSamples(SPEECH_SAMPLE_RATE, message.chime ?? 'plain')),
				);
			}
		}

		const playing = this.playing;
		this.encodeInto(playing, Buffer.from(message.base64, 'base64'));

		if (message.isLast) {
			for (const frame of playing.splitter.flush()) {
				playing.sink.push(this.options.codec.encode(frame));
			}

			playing.sink.end();
			playing.hasEnded = true;
		}

		return true;
	}

	private encodeInto(playing: Playing, mono: Uint8Array): void {
		const stereo = toDiscordStereo({ mono, sampleRate: SPEECH_SAMPLE_RATE });

		for (const frame of playing.splitter.push(stereo)) {
			playing.sink.push(this.options.codec.encode(frame));
		}
	}

	private cancel(id: string): void {
		if (this.playing?.id !== id) {
			return;
		}

		this.playing = null;
		this.link?.stopPlayback();
		log.info('clip cut', { id });
	}

	// Discord finished playing what it was given: the clip is done, as a page's audio_done says.
	private playbackIdle(): void {
		const playing = this.playing;

		if (!playing?.hasEnded) {
			return;
		}

		this.playing = null;
		this.options.onClipDone(playing.id);
	}
}
