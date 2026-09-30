import { createLogger } from '../log.js';
import {
	isSdkAsk,
	type MeanwhileItem,
	type SpeechMessage,
	type SpokenLine,
	type State,
} from '../shared/protocol.js';
import { prefixSessionName, stripSessionName, stripTags } from '../shared/spoken.js';
import { readLabel } from '../state/helpers.js';
import { hasBackgroundWork } from '../state/subagents.js';
import {
	decideTurnLine,
	describeDoneAbout,
	isHeldQuestion,
	isOnAnotherSession,
	isOnScreen,
	isShortLine,
	readAnnouncedLabel,
} from '../state/held-lines.js';
import type { Store } from '../state/store.js';
import { readSubject } from '../state/exchange.js';
import { isRecent, type SpokenRecord } from './echo.js';
import {
	createEmptyQueue,
	GAP_BEFORE_ASK_MS,
	MAX_GAP_WAIT_MS,
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
import { decideMeanwhile } from './meanwhile.js';

interface SayParams {
	text: string;
	priority: SpeechPriority;
	ref?: string | null;
	source?: SpokenLine['source'];
	isNamed?: boolean;
	isReply?: boolean;
	isAnswer?: boolean;
	isAsking?: boolean;
	isOwed?: boolean;
	waitsForGap?: boolean;
	isAck?: boolean;
	isHoldable?: boolean;
	chime?: 'needs';
	// "checkout is done: …": another session's update, said later in the meanwhile line instead.
	announcement?: { kind: MeanwhileItem['kind']; about: string | null };
}

interface FinishParams {
	// The clip stops before it played out: Soniox stops generating and the tab drops it.
	isCut?: boolean;
	// No tab or voice: the line is on the page, but nobody heard it.
	isUnplayed?: boolean;
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
	// Whether any page is open: a reminder nobody can hear is not said, and not counted.
	hasPage?: () => boolean;
	now?: () => number;
	// Tests run the clock themselves; returns what clearTimer takes.
	setTimer?: (run: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	// A tab listens all the time (on demand, hands-free): the quiet before "meanwhile" is longer.
	isListening?: () => boolean;
}

interface Playing {
	id: string;
	item: SpeechItem;
	tab: string | null;
	timer?: unknown;
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
// Per ask: a question left overnight is not repeated every five minutes until morning.
export const MAX_REMINDERS = 3;
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
	// Reminders said, by what waits (the ask, or the line that asked): a new question starts over.
	private remindersSaid = new Map<string, number>();
	private spokenRecords: SpokenRecord[] = [];
	private now: () => number;
	private setTimer: (run: () => void, ms: number) => unknown;
	private clearTimer: (timer: unknown) => void;
	// Since nothing was said either way: the meanwhile line waits for enough of it.
	private quietSince: number;
	private meanwhileTimer: unknown = undefined;
	private gapTimer: unknown = undefined;

	constructor(private options: VoiceOutOptions) {
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
		this.clearTimer =
			options.clearTimer ??
			((timer) => clearTimeout(timer as ReturnType<typeof setTimeout> | undefined));
		this.quietSince = this.now();
		options.store.subscribe((stamped) => {
			// After the dispatch that switched: a line held from inside it would reach the pages first.
			if (stamped.input.type === 'switch_view') {
				queueMicrotask(() => this.viewChanged());
			}

			if (stamped.input.type === 'meanwhile_added') {
				this.scheduleMeanwhile();
			}
		});
	}

	say({
		text,
		priority,
		ref = null,
		source = 'narrator',
		isNamed = false,
		isReply = false,
		isAnswer = false,
		isAsking = false,
		waitsForGap = false,
		isOwed = false,
		isAck = false,
		isHoldable = false,
		chime,
		announcement,
	}: SayParams): void {
		if (!text.trim()) {
			return;
		}

		// Another session's update waits for a quiet moment, with the others', as one line.
		if (announcement && ref) {
			this.options.store.dispatch({ type: 'meanwhile_added', ref, ...announcement });

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
			...(isAnswer ? { isAnswer } : {}),
			...(waitsForGap ? { waitsForGap } : {}),
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
		// Nothing queued is dropped: it waits for the developer to finish, behind what answers them.
		this.isTalking = true;
		this.quietSince = this.now();

		if (this.playing) {
			this.finish(this.playing.id, { isCut: true, shouldPlayNext: false });
		}
	}

	talkEnded(): void {
		if (!this.isTalking) {
			return;
		}

		this.isTalking = false;
		this.quietSince = this.now();
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
		const waiting = new Map<string, string>();

		// A held /clear is not nagged about: it lapses on its own.
		for (const ask of state.asks.filter(isSdkAsk)) {
			if (!waiting.has(ask.ref)) {
				waiting.set(ask.ref, ask.id);
			}
		}

		for (const session of Object.values(state.sessions)) {
			if (session.needsUser && !waiting.has(session.ref)) {
				waiting.set(session.ref, `${session.ref}@${session.needsUser.at}`);
			}
		}

		const hasPage = this.options.hasPage?.() ?? true;

		for (const [ref, waitKey] of waiting) {
			const lastSpokenAt = this.lastSpokenAbout.get(ref);

			if (lastSpokenAt === undefined) {
				// First time seen waiting: its own alert or narration already spoke.
				this.lastSpokenAbout.set(ref, now);
				continue;
			}

			const said = this.remindersSaid.get(waitKey) ?? 0;

			if (!hasPage || now - lastSpokenAt < REMINDER_MS || said >= MAX_REMINDERS) {
				continue;
			}

			this.remindersSaid.set(waitKey, said + 1);
			// One phrase for "waits on you". Only a question already heard makes it something a bare
			// "yes" answers; one only announced has not been heard.
			this.say({
				text: `${readAnnouncedLabel(state, ref, readLabel(state, ref))} still needs you.`,
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

		const waitKeys = new Set(waiting.values());

		for (const waitKey of this.remindersSaid.keys()) {
			if (!waitKeys.has(waitKey)) {
				this.remindersSaid.delete(waitKey);
			}
		}
	}

	private viewChanged(): void {
		// The developer clicked away from the session whose line plays: it stops, and waits there to
		// be heard on return. Mission Control hears every session, and a question still waits on them.
		const playing = this.playing;
		const item = playing?.item;
		const { store } = this.options;

		if (
			!playing ||
			!item?.ref ||
			!item.isHoldable ||
			item.isAsking ||
			item.source !== 'narrator' ||
			!isOnAnotherSession(store.state, item.ref)
		) {
			return;
		}

		// Its session stopped meanwhile: nothing is kept for it, as when a queued line is held.
		if (store.state.sessions[item.ref]?.status === 'stopped') {
			log.info('line cut: view left, session stopped', { id: item.id, ref: item.ref });
		} else {
			store.dispatch({
				type: 'line_held',
				ref: item.ref,
				text: stripTags(item.text),
				isAsking: false,
			});
			log.info('line cut and held: view left', { id: item.id, ref: item.ref });
		}

		this.finish(playing.id, { isCut: true });
	}

	private finish(
		id: string,
		{ isCut = false, isUnplayed = false, shouldPlayNext = true }: FinishParams = {},
	): void {
		const playing = this.playing;

		if (playing?.id !== id) {
			return;
		}

		this.clearTimer(playing.timer);
		this.playing = null;
		playing.record.endedAt = this.now();
		this.quietSince = this.now();

		if (playing.lineId) {
			this.options.store.dispatch({
				type: 'spoken_ended',
				lineId: playing.lineId,
				isCut,
				...(isUnplayed ? { isUnplayed: true as const } : {}),
			});
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

		if (!item.isHoldable || !item.ref || isOnScreen(store.state, item.ref)) {
			return false;
		}

		const session = store.state.sessions[item.ref];
		const decision = decideTurnLine({
			isShown: false,
			isSubject: readSubject(store.state, this.now()) === item.ref,
			isShort: isShortLine(item.text),
			isHeldAnnounced: session?.heldLine?.isAnnounced === true,
			hasBackgroundAgents: session ? hasBackgroundWork(session) : false,
			needsUser: Boolean(item.isAsking),
			isOnAnotherSession: isOnAnotherSession(store.state, item.ref),
		});

		if (decision.kind === 'say') {
			return false;
		}

		// Its session stopped meanwhile: nothing is kept for it, and nothing announced.
		if (session?.status === 'stopped') {
			log.info('line dropped: session stopped', { id: item.id, ref: item.ref });

			return true;
		}

		store.dispatch({
			type: 'line_held',
			ref: item.ref,
			text: stripTags(item.text),
			isAsking: Boolean(item.isAsking),
		});
		log.info('line held', { id: item.id, ref: item.ref });

		// Its turn already ended, so no announcement is coming from it: this is the announcement. A
		// question or plan it waits on was not skipped (this line was never heard): its own alert tells it.
		const held = store.state.sessions[item.ref]?.heldLine;
		const kind = decision.announce;
		const isTurnOver = session && session.status !== 'running' && session.status !== 'blocked';

		if (!isTurnOver || !held) {
			return true;
		}

		if (!kind) {
			log.info('not announced', { id: item.id, ref: item.ref });

			return true;
		}

		store.dispatch({ type: 'held_line_announced', ref: item.ref, id: held.id });
		store.dispatch({
			type: 'meanwhile_added',
			ref: item.ref,
			kind,
			about:
				kind === 'done'
					? describeDoneAbout({
							topic: session.topic,
							isTopicPinned: session.isTopicPinned,
							asked: session.requests.at(-1)?.text ?? null,
						})
					: null,
		});

		return true;
	}

	// Plays the waiting updates once the developer and Voice OS have both been quiet long enough, or
	// once the oldest has waited too long; only ever between turns, never over speech.
	private scheduleMeanwhile(): void {
		this.clearTimer(this.meanwhileTimer);
		this.meanwhileTimer = undefined;

		if (this.playing || this.isTalking || this.queue.items.length > 0) {
			return;
		}

		const timing = decideMeanwhile({
			items: this.options.store.state.meanwhile,
			now: this.now(),
			quietSince: this.quietSince,
			isListening: this.options.isListening?.() ?? false,
		});

		if (timing.kind === 'now') {
			this.options.store.dispatch({ type: 'play_meanwhile' });
		} else if (timing.kind === 'wait') {
			this.meanwhileTimer = this.setTimer(() => this.scheduleMeanwhile(), timing.ms);
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
		this.clearTimer(playing.timer);
		playing.timer = this.setTimer(() => this.finish(playing.id, { isCut: !playing.hasEnded }), ms);
	}

	private async pump(): Promise<void> {
		if (this.playing || this.isTalking) {
			return;
		}

		const { item, queue } = takeNextItem(this.queue, {
			now: this.now(),
			exchangeRef: this.options.store.state.exchange?.ref ?? null,
		});
		this.queue = queue;

		if (!item) {
			this.scheduleMeanwhile();

			return;
		}

		// Another session's ask waits for a breath after the last line, not the whole quiet.
		const gapLeft = item.waitsForGap
			? Math.min(
					GAP_BEFORE_ASK_MS - (this.now() - this.quietSince),
					MAX_GAP_WAIT_MS - (this.now() - item.at),
				)
			: 0;

		if (gapLeft > 0) {
			this.queue = { ...this.queue, items: [item, ...this.queue.items] };
			this.clearTimer(this.gapTimer);
			this.gapTimer = this.setTimer(() => void this.pump(), gapLeft);

			return;
		}

		if (this.holdIfOffScreen(item)) {
			void this.pump();

			return;
		}

		// Audio goes only to the tab used last, so two open tabs never talk over each other.
		const tab = this.options.speaker();
		const voiced = this.resolveSpokenText(item);
		// Tags reach the voice only; in a short line one can swallow the words after it.
		const text = stripTags(voiced);
		const synthesized = isShortLine(voiced) ? text : voiced;
		const record: SpokenRecord = { text, endedAt: null };
		const now = this.now();
		this.spokenRecords = [...this.spokenRecords.filter((line) => isRecent(line, now)), record];
		const playing: Playing = {
			id: item.id,
			item,
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
			...(item.isAnswer ? { isAnswer: true as const } : {}),
		});
		playing.lineId = spokenState.spoken.at(-1)?.id ?? null;

		const synthesize = this.options.synthesize;

		if (!synthesize || !tab) {
			this.finish(item.id, { isUnplayed: true });

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
				text: synthesized,
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
