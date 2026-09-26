import { createLogger } from '../log.js';
import type { SpeechMessage, SpokenLine, State } from '../shared/protocol.js';
import { prefixSessionName, stripSessionName } from '../shared/spoken.js';
import { readLabel } from '../state/helpers.js';
import type { Store } from '../state/store.js';
import { isRecent, type SpokenRecord } from './echo.js';
import {
	clearQueueForTalk,
	createEmptyQueue,
	enqueue,
	setMuted,
	shouldChime,
	takeNextItem,
	type SpeechItem,
	type SpeechPriority,
	type SpeechQueue,
} from './queue.js';
import { computePcmSeconds, type Synthesize } from './tts.js';

interface SayParams {
	text: string;
	priority: SpeechPriority;
	ref?: string | null;
	source?: SpokenLine['source'];
	isNamed?: boolean;
	isReply?: boolean;
	isAsking?: boolean;
}

interface FinishParams {
	// The clip stops before it played out: Soniox stops generating and the tab drops it.
	isCut?: boolean;
	shouldPlayNext?: boolean;
}

// Sends to one browser tab; false when that tab is gone.
export type AudioSink = (tab: string, message: SpeechMessage) => boolean;

export interface VoiceOutOptions {
	store: Store;
	synthesize: Synthesize | null;
	play: AudioSink;
	// The tab the developer used last; a clip keeps the tab it started in.
	speaker: () => string | null;
	now?: () => number;
}

interface Playing {
	id: string;
	tab: string | null;
	timer?: ReturnType<typeof setTimeout>;
	abort: AbortController;
	hasEnded: boolean;
	record: SpokenRecord;
}

const log = createLogger('voice-out');
export const REMINDER_MS = 5 * 60_000;
const CHUNK_GAP_MS = 10_000;
const PLAYBACK_MARGIN_SECONDS = 3;

// Counts across every VoiceOut, so clip ids never repeat.
let clipCounter = 0;

export class VoiceOut {
	private queue: SpeechQueue = createEmptyQueue();
	// Nothing plays during a press, not even an alert: the open mic would transcribe it as theirs.
	private isTalking = false;
	private playing: Playing | null = null;
	private lastSpokenAbout = new Map<string, number>();
	private spokenRecords: SpokenRecord[] = [];
	private now: () => number;

	constructor(private options: VoiceOutOptions) {
		this.now = options.now ?? Date.now;
	}

	say({
		text,
		priority,
		ref = null,
		source = 'narrator',
		isNamed = false,
		isReply = false,
		isAsking = false,
	}: SayParams): void {
		if (!text.trim()) {
			return;
		}

		clipCounter += 1;
		const result = enqueue(this.queue, {
			id: `s${clipCounter}`,
			text,
			priority,
			ref,
			source,
			isNamed,
			isReply,
			isAsking,
			at: this.now(),
		});
		this.queue = result.queue;

		if (result.isDropped) {
			log.debug('dropped (muted)', { priority });

			return;
		}

		if (ref) {
			this.lastSpokenAbout.set(ref, this.now());
		}

		if (result.shouldInterrupt && this.playing && !this.isTalking) {
			this.finish(this.playing.id, { isCut: true });
		}

		void this.pump();
	}

	clipDone(id: string): void {
		if (this.playing?.id === id) {
			this.finish(id);
		}
	}

	talkStarted(): void {
		this.isTalking = true;
		this.queue = clearQueueForTalk(this.queue);

		if (this.playing) {
			this.finish(this.playing.id, { isCut: true, shouldPlayNext: false });
		}
	}

	talkEnded(): void {
		if (!this.isTalking) {
			return;
		}

		this.isTalking = false;
		void this.pump();
	}

	listRecentSpeech(): SpokenRecord[] {
		// Exactly as spoken: an open mic hears it back as echo.
		const now = this.now();

		return this.spokenRecords.filter((line) => isRecent(line, now)).map((line) => ({ ...line }));
	}

	mute(isMuted = true): void {
		this.queue = setMuted(this.queue, isMuted);
		log.info(isMuted ? 'muted' : 'unmuted');
	}

	remind(state: State): void {
		const now = this.now();
		const waiting = new Set([
			...state.asks.map((ask) => ask.ref),
			...Object.values(state.sessions)
				.filter((session) => session.needsUser)
				.map((session) => session.ref),
		]);

		for (const ref of waiting) {
			const lastSpokenAt = this.lastSpokenAbout.get(ref);

			if (lastSpokenAt === undefined) {
				// First time seen waiting: its own alert or narration already spoke.
				this.lastSpokenAbout.set(ref, now);
				continue;
			}

			if (now - lastSpokenAt < REMINDER_MS) {
				continue;
			}

			this.say({
				text: `${readLabel(state, ref)} is still waiting on you.`,
				priority: 'high',
				ref,
				isAsking: true,
			});
		}

		for (const ref of this.lastSpokenAbout.keys()) {
			if (!waiting.has(ref)) {
				this.lastSpokenAbout.delete(ref);
			}
		}
	}

	private finish(id: string, { isCut = false, shouldPlayNext = true }: FinishParams = {}): void {
		const playing = this.playing;

		if (playing?.id !== id) {
			return;
		}

		clearTimeout(playing.timer);
		this.playing = null;
		playing.record.endedAt = this.now();

		// Even when every chunk was sent: a short clip is fully streamed while it still plays.
		if (isCut) {
			playing.abort.abort();

			if (playing.tab) {
				this.options.play(playing.tab, { type: 'audio_cancel', id });
			}

			log.info('clip cut', { id });
		}

		if (shouldPlayNext) {
			void this.pump();
		}
	}

	private resolveSpokenText(item: SpeechItem): string {
		if (!item.isNamed || !item.ref) {
			return item.text;
		}

		// Decided as the line plays: the developer may have switched to that session meanwhile.
		const view = this.options.store.state.view;
		const isOnScreen = view.kind === 'session' && view.ref === item.ref;

		return isOnScreen
			? stripSessionName(item.text)
			: prefixSessionName(readLabel(this.options.store.state, item.ref), item.text);
	}

	private armTimer(playing: Playing, ms: number): void {
		clearTimeout(playing.timer);
		playing.timer = setTimeout(() => this.finish(playing.id, { isCut: !playing.hasEnded }), ms);
	}

	private async pump(): Promise<void> {
		if (this.playing || this.isTalking) {
			return;
		}

		const { item, queue } = takeNextItem(this.queue, this.now());
		this.queue = queue;

		if (!item) {
			return;
		}

		// Audio goes only to the tab used last, so two open tabs never talk over each other.
		const tab = this.options.speaker();
		const text = this.resolveSpokenText(item);
		const record: SpokenRecord = { text, endedAt: null };
		const now = this.now();
		this.spokenRecords = [...this.spokenRecords.filter((line) => isRecent(line, now)), record];
		const playing: Playing = {
			id: item.id,
			tab,
			abort: new AbortController(),
			hasEnded: false,
			record,
		};
		this.playing = playing;
		// Silence from Soniox this long mid-clip means the clip is stuck.
		this.armTimer(playing, CHUNK_GAP_MS);
		this.options.store.dispatch({
			type: 'spoken',
			text,
			source: item.source,
			...(item.ref ? { ref: item.ref } : {}),
			...(item.isAsking ? { isAsking: true as const } : {}),
		});

		const synthesize = this.options.synthesize;

		if (!synthesize || !tab) {
			this.finish(item.id);

			return;
		}

		// Counted across audio callbacks to size the playback fallback.
		let bytes = 0;
		// Decided as the clip starts (a reply that waited is no longer one); only the first chunk chimes.
		let shouldPlayChime = shouldChime(item, this.now());

		const sendToTab = (message: SpeechMessage) => {
			if (this.playing !== playing) {
				return;
			}

			if (!this.options.play(tab, message)) {
				this.finish(item.id, { isCut: true });
			}
		};

		try {
			await synthesize({
				id: item.id,
				text,
				signal: playing.abort.signal,
				onAudio: (pcm) => {
					if (this.playing !== playing) {
						return;
					}

					bytes += pcm.byteLength;
					this.armTimer(playing, CHUNK_GAP_MS);
					sendToTab({
						type: 'audio',
						id: item.id,
						base64: Buffer.from(pcm).toString('base64'),
						isLast: false,
						...(shouldPlayChime ? { hasChime: shouldPlayChime } : {}),
					});
					shouldPlayChime = false;
				},
			});

			if (this.playing !== playing) {
				return;
			}

			sendToTab({ type: 'audio', id: item.id, base64: '', isLast: true });
			playing.hasEnded = true;

			// The tab reports audio_done when playback ends; this only covers a tab that never does.
			if (this.playing === playing) {
				this.armTimer(playing, (computePcmSeconds(bytes) + PLAYBACK_MARGIN_SECONDS) * 1000);
			}
		} catch (error) {
			log.warn('speech failed', { id: item.id, error: String(error) });
			this.finish(item.id, { isCut: true });
		}
	}
}
