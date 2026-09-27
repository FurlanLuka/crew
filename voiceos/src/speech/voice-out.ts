import { createLogger } from '../log.js';
import { isSdkAsk, type SpeechMessage, type SpokenLine, type State } from '../shared/protocol.js';
import { prefixSessionName, stripSessionName } from '../shared/spoken.js';
import { readLabel } from '../state/helpers.js';
import {
	describeAnnouncement,
	isHeldQuestion,
	isOnScreen,
	isShortLine,
} from '../state/held-lines.js';
import type { Store } from '../state/store.js';
import { isRecent, type SpokenRecord } from './echo.js';
import {
	clearQueueForTalk,
	createEmptyQueue,
	dropQueued,
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
	isOwed?: boolean;
	isAck?: boolean;
	isHoldable?: boolean;
	chime?: 'needs';
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
	// Its line in the state, told when it stops playing.
	lineId: string | null;
	// A line the developer waits for plays out: an alert waits behind it instead of cutting it off.
	isOwed: boolean;
}

const SAID_PREVIEW_CHARS = 80;

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
		isOwed = false,
		isAck = false,
		isHoldable = false,
		chime,
	}: SayParams): void {
		if (!text.trim()) {
			return;
		}

		clipCounter += 1;
		const id = `s${clipCounter}`;
		const result = enqueue(this.queue, {
			id,
			text,
			priority,
			ref,
			source,
			isNamed,
			isReply,
			isAsking,
			...(isOwed ? { isOwed } : {}),
			...(isAck ? { isAck } : {}),
			...(isHoldable ? { isHoldable } : {}),
			...(chime ? { chime } : {}),
			at: this.now(),
		});
		this.queue = result.queue;
		// Which line each clip is, and whether it plays: "why did I hear that twice" is answered here.
		log.info('queued line', {
			id,
			source,
			ref,
			priority,
			text: text.length > SAID_PREVIEW_CHARS ? `${text.slice(0, SAID_PREVIEW_CHARS)}…` : text,
			...(result.isDropped ? { isDropped: true } : {}),
		});

		if (result.isDropped) {
			return;
		}

		if (ref) {
			this.lastSpokenAbout.set(ref, this.now());
		}

		if (result.shouldInterrupt && this.playing && !this.playing.isOwed && !this.isTalking) {
			this.finish(this.playing.id, { isCut: true });
		}

		void this.pump();
	}

	dropQueuedAbout(ref: string, before: number): void {
		const count = this.queue.items.length;
		this.queue = dropQueued(this.queue, { ref, before });

		if (this.queue.items.length < count) {
			log.info('dropped stale lines', { ref, count: count - this.queue.items.length });
		}
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
			// A held /clear is not nagged about: it lapses on its own.
			...state.asks.filter(isSdkAsk).map((ask) => ask.ref),
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

			// One phrase for "waits on you". Only a question already heard makes it something a bare
			// "yes" answers; one only announced has not been heard.
			this.say({
				text: `${readLabel(state, ref)} still needs you.`,
				priority: 'high',
				ref,
				isAsking: !isHeldQuestion(state.sessions[ref]),
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

		if (playing.lineId) {
			this.options.store.dispatch({ type: 'spoken_ended', lineId: playing.lineId, isCut });
		}

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

	private holdIfOffScreen(item: SpeechItem): boolean {
		// Queued while its session was on screen; the developer went elsewhere before it played.
		const { store } = this.options;

		if (
			!item.isHoldable ||
			!item.ref ||
			isOnScreen(store.state, item.ref) ||
			isShortLine(item.text)
		) {
			return false;
		}

		const session = store.state.sessions[item.ref];

		// Its session stopped meanwhile: nothing is kept for it, and nothing announced.
		if (session?.status === 'stopped') {
			log.info('line dropped: session stopped', { id: item.id, ref: item.ref });

			return true;
		}

		store.dispatch({
			type: 'line_held',
			ref: item.ref,
			text: item.text,
			isAsking: Boolean(item.isAsking),
		});
		log.info('line held', { id: item.id, ref: item.ref });

		// Its turn already ended, so no announcement is coming from it: this is the announcement.
		if (session && session.status !== 'running' && session.status !== 'blocked') {
			const kind = item.isAsking ? 'needs' : 'done';
			this.say({
				text: describeAnnouncement({ label: session.label, kind }),
				priority: kind === 'needs' ? 'high' : 'normal',
				source: 'narrator',
				ref: item.ref,
				...(kind === 'needs' ? { chime: 'needs' as const } : {}),
			});
		}

		return true;
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

		if (this.holdIfOffScreen(item)) {
			void this.pump();

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
			lineId: null,
			isOwed: Boolean(item.isOwed),
		};
		this.playing = playing;
		// Silence from Soniox this long mid-clip means the clip is stuck.
		this.armTimer(playing, CHUNK_GAP_MS);
		const spokenState = this.options.store.dispatch({
			type: 'spoken',
			text,
			source: item.source,
			...(item.ref ? { ref: item.ref } : {}),
			...(item.isAsking ? { isAsking: true as const } : {}),
		});
		playing.lineId = spokenState.spoken.at(-1)?.id ?? null;

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
						...(shouldPlayChime && item.chime ? { chime: item.chime } : {}),
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
