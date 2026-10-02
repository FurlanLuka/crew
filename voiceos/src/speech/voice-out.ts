import { createLogger } from '../log.js';
import {
	isSdkAsk,
	type MeanwhileItem,
	type SpeechMessage,
	type SpokenLine,
	type State,
	type ToldAsk,
} from '../shared/protocol.js';
import {
	normalizeUtterance,
	prefixSessionName,
	stripSessionName,
	stripTags,
} from '../shared/spoken.js';
import { countSpokenWords, readLabel } from '../state/helpers.js';
import { hasBackgroundWork } from '../state/subagents.js';
import {
	decideTurnLine,
	describeDoneAbout,
	isHeldQuestion,
	isOnAnotherSession,
	isOnScreen,
	isShortLine,
} from '../state/held-lines.js';
import type { Store } from '../state/store.js';
import { isRecent, type SpokenRecord } from './echo.js';
import {
	createEmptyQueue,
	GAP_BEFORE_ASK_MS,
	MAX_GAP_WAIT_MS,
	dropClosedAsks,
	isClosedAskLine,
	type OpenAsks,
	dropQueued,
	enqueue,
	isInstantAck,
	isReplyLine,
	setMuted,
	settleWording,
	shouldChime,
	takeNextItem,
	withoutInstantAcks,
	type SpeechItem,
	type SpeechPriority,
	type SpeechQueue,
} from './queue.js';
import { computePcmSeconds, type Synthesize } from './tts.js';
import { decideMeanwhile } from './meanwhile.js';
import { toAskLine } from '../state/asks.js';
import type { FollowUpFacts } from '../shared/follow-up.js';
import type { FollowUpInput } from '../voice-lines/prompt.js';
import { MIN_REQUEST_WORDS } from '../tools/tools.js';
import {
	decideInstantAck,
	INSTANT_ACK_DELAY_MS,
	type KernelTurnHandle,
	type KernelTurnStart,
	pickInstantAck,
	rememberInstantAck,
} from './instant-ack.js';

const readOpenAsks = (state: State): OpenAsks =>
	new Map(
		state.asks.map((ask) => {
			const { askId, askQuestion } = toAskLine(ask);

			return [askId, askQuestion ?? null];
		}),
	);

const readWaitingKey = (items: MeanwhileItem[]): string =>
	items.map((item) => `${item.ref}@${item.at}:${item.askId ?? ''}`).join('|');

interface SayParams {
	text: string;
	priority: SpeechPriority;
	ref?: string | null;
	source?: SpokenLine['source'];
	isNamed?: boolean;
	isReply?: boolean;
	isAnswer?: boolean;
	isAsking?: boolean;
	askId?: string;
	askQuestion?: number;
	isUpdate?: boolean;
	refs?: string[];
	toldAsks?: ToldAsk[];
	isOwed?: boolean;
	waitsForGap?: boolean;
	isAck?: boolean;
	isHoldable?: boolean;
	chime?: 'needs';
	// "checkout is done: …": another session's update, said later in the meanwhile line instead.
	announcement?: { kind: MeanwhileItem['kind']; about: string | null };
	isFiller?: boolean;
	keepsTags?: boolean;
	// What Voice OS did, for the writer: the line is worded when one is set up.
	facts?: FollowUpFacts;
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
	// Words a follow-up line ("Sent to checkout.") with a small model; null keeps the fixed text.
	writeFollowUp?: (input: FollowUpInput) => Promise<string | null>;
}

// What is said or heard right now, for whoever decides to speak up on its own (progress.ts).
export interface SpeechMoment {
	isTalking: boolean;
	isMuted: boolean;
	isBusy: boolean;
	quietSince: number;
	hasPage: boolean;
	isListening: boolean;
}

// The kernel turn under way: the instant ack it got, if any.
interface AckTurn {
	startedAt: number;
	ack: string | null;
	isOver: boolean;
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
	// Some of it reached the tab: before that, a withdrawn ack was never heard.
	hasAudio: boolean;
}

const SAID_PREVIEW_CHARS = 80;

const log = createLogger('voice-out');

export const REMINDER_MS = 5 * 60_000;
// Per ask: a question left overnight is not repeated every five minutes until morning.
export const MAX_REMINDERS = 3;
const CHUNK_GAP_MS = 10_000;
const PLAYBACK_MARGIN_SECONDS = 3;
// How long a follow-up keeps its place for its wording: longer when an ack already broke the silence.
export const WORDING_WAIT_MS = 600;
export const WORDING_WAIT_AFTER_ACK_MS = 1_000;

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
	// One line held at the head of the queue (a gap before an ask, a wording on its way) wakes it.
	private headTimer: unknown = undefined;
	// The instant acks said last: the next is a different one.
	private ackHistory: string[] = [];
	// When Voice OS last finished a line the developer heard; null before the first.
	private lastSpokeAt: number | null = null;
	private lastReplyQueuedAt = Number.NEGATIVE_INFINITY;
	private turn: AckTurn | null = null;

	constructor(private options: VoiceOutOptions) {
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
		this.clearTimer =
			options.clearTimer ??
			((timer) => clearTimeout(timer as ReturnType<typeof setTimeout> | undefined));
		this.quietSince = this.now();
		let waitingKey = '';
		options.store.subscribe((stamped, state) => {
			// After the dispatch that switched: a line held from inside it would reach the pages first.
			if (stamped.input.type === 'switch_view') {
				queueMicrotask(() => this.viewChanged());
			}

			if (this.saysClosedAsk(state)) {
				queueMicrotask(() => this.asksClosed());
			}

			// An update arrives from its own input or with an ask; a newer one replaces a session's older one
			// in place, so the list is compared item by item. Played at once, from inside this dispatch the
			// page would get the play before the update it plays, see a gap, reconnect and cut the line.
			const key = readWaitingKey(state.meanwhile);

			if (key !== waitingKey) {
				waitingKey = key;

				if (state.meanwhile.length > 0) {
					queueMicrotask(() => this.scheduleMeanwhile());
				}
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
		askId,
		askQuestion,
		isUpdate = false,
		refs,
		toldAsks,
		waitsForGap = false,
		isOwed = false,
		isAck = false,
		isHoldable = false,
		chime,
		announcement,
		isFiller = false,
		keepsTags = false,
		facts,
	}: SayParams): void {
		if (!text.trim()) {
			return;
		}

		// Another session's update waits for a quiet moment, with the others', as one line.
		if (announcement && ref) {
			this.options.store.dispatch({ type: 'meanwhile_added', ref, ...announcement });

			return;
		}

		// Voice OS's own word said twice in a breath ("Switching to crew." from the switch and again as the
		// kernel's reply — debug note 31): the second is dropped while the first is still to be heard.
		// Once that one has played, or was cut, the same words are a new line ("Sent to checkout." twice).
		if (source === 'kernel' && this.isKernelLineAhead(text)) {
			log.info('repeated line dropped', { text });

			return;
		}

		clipCounter += 1;
		const id = `s${clipCounter}`;
		const writeFollowUp = facts ? this.options.writeFollowUp : undefined;
		const line: SpeechItem = {
			id,
			text,
			priority,
			ref,
			source,
			isNamed,
			isReply,
			isAsking,
			...(askId ? { askId } : {}),
			...(askQuestion === undefined ? {} : { askQuestion }),
			...(isAnswer ? { isAnswer } : {}),
			...(isUpdate ? { isUpdate } : {}),
			...(refs?.length ? { refs } : {}),
			...(toldAsks?.length ? { toldAsks } : {}),
			...(waitsForGap ? { waitsForGap } : {}),
			...(isOwed ? { isOwed } : {}),
			...(isAck ? { isAck } : {}),
			...(isHoldable ? { isHoldable } : {}),
			...(chime ? { chime } : {}),
			...(isFiller ? { isFiller } : {}),
			...(keepsTags ? { keepsTags } : {}),
			at: this.now(),
		};
		const isAnswering = !isFiller && isReplyLine(line);

		// First: a withdrawn ack was never heard, so neither the wording nor its wait counts on it.
		if (isAnswering) {
			this.withdrawAck();
		}

		const lastAck = this.turn?.ack ?? null;
		const wordingWait = lastAck ? WORDING_WAIT_AFTER_ACK_MS : WORDING_WAIT_MS;
		const item: SpeechItem = writeFollowUp
			? { ...line, fixedText: text, wordingUntil: this.now() + wordingWait }
			: line;
		const result = enqueue(this.queue, item);
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

		// Filler about a session is not news about it: its reminder clock is left alone.
		if (ref && !isFiller) {
			this.lastSpokenAbout.set(ref, this.now());
		}

		if (isAnswering) {
			this.lastReplyQueuedAt = this.now();
		}

		if (writeFollowUp && facts) {
			void this.word(id, writeFollowUp, { facts, fixedText: text, lastAck });
		}

		if (result.shouldInterrupt && this.playing && !this.playing.isOwed && !this.isTalking) {
			this.finish(this.playing.id, { isCut: true });
		}

		void this.pump();
	}

	// A worded line counts as its fixed text: the same words said again are still the same line. An
	// ack's "Okay." is filler, never the line a kernel reply "Okay." repeats.
	private isKernelLineAhead(text: string): boolean {
		const said = normalizeUtterance(text);
		const ahead = this.playing ? [this.playing.item, ...this.queue.items] : this.queue.items;

		return ahead.some(
			(item) =>
				item.source === 'kernel' &&
				!item.isFiller &&
				normalizeUtterance(item.fixedText ?? item.text) === said,
		);
	}

	// The wording replaces the text only while the line still waits; once it played, or went, it is too
	// late, and the developer heard the fixed text.
	private async word(
		id: string,
		writeFollowUp: (input: FollowUpInput) => Promise<string | null>,
		input: FollowUpInput,
	): Promise<void> {
		let worded: string | null = null;

		try {
			worded = await writeFollowUp(input);
		} catch (error) {
			log.warn('follow-up not worded', { id, error: String(error) });
		}

		const settled = settleWording(this.queue, { id, worded });

		if (!settled.isQueued) {
			if (worded) {
				log.info('worded line discarded: too late', { id, kind: input.facts.kind });
			}

			return;
		}

		// Beside "queued line": which words the developer is about to hear in place of the fixed ones.
		if (worded) {
			log.info('worded line', { id, text: worded });
		}

		this.queue = settled.queue;
		void this.pump();
	}

	// The router hands a voice turn to the kernel: unless something answers first, a short "Mm-hm."
	// fills the wait. cancel() once the turn is over: an ack not yet said is not said.
	kernelTurnStarted({ text, startedAt }: KernelTurnStart): KernelTurnHandle {
		const turn: AckTurn = { startedAt, ack: null, isOver: false };
		this.turn = turn;
		const delay = Math.max(0, INSTANT_ACK_DELAY_MS - (this.now() - startedAt));
		const timer = this.setTimer(() => this.sayInstantAck(turn, text), delay);

		return {
			cancel: () => {
				turn.isOver = true;
				this.clearTimer(timer);

				if (this.turn === turn) {
					this.turn = null;
				}
			},
		};
	}

	private sayInstantAck(turn: AckTurn, text: string): void {
		if (turn.isOver) {
			return;
		}

		const now = this.now();
		const elapsedMs = now - turn.startedAt;
		const decision = decideInstantAck({
			isMuted: this.queue.isMuted,
			words: countSpokenWords(text),
			minWords: MIN_REQUEST_WORDS,
			msSinceSpoke: this.lastSpokeAt === null ? null : now - this.lastSpokeAt,
			hasReplySinceTurn: this.lastReplyQueuedAt >= turn.startedAt,
			isPlayingOrQueued: this.isBusy(),
			isTalking: this.isTalking,
		});

		if (decision.kind === 'skip') {
			log.info('instant ack skipped', { reason: decision.reason, elapsedMs });

			return;
		}

		const line = pickInstantAck(this.ackHistory);
		this.ackHistory = rememberInstantAck(this.ackHistory, line.text);
		// The writer reads what was heard, not how it was voiced.
		turn.ack = stripTags(line.text);
		log.info('instant ack said', { text: line.text, elapsedMs });
		this.say({
			text: line.text,
			priority: 'high',
			source: 'kernel',
			isReply: true,
			isFiller: true,
			...(line.keepsTags ? { keepsTags: true } : {}),
		});
	}

	// The answer is here: an ack the developer has not heard yet would only stand in front of it. Once
	// withdrawn it was never said, for the wording and its wait as much as for the developer.
	private withdrawAck(): void {
		const count = this.queue.items.length;
		this.queue = withoutInstantAcks(this.queue);
		const playing = this.playing;
		const isCut = playing !== null && isInstantAck(playing.item) && !playing.hasAudio;

		if (!isCut && this.queue.items.length === count) {
			return;
		}

		log.info('instant ack withdrawn', { reason: 'reply' });

		if (this.turn) {
			this.turn.ack = null;
		}

		if (isCut && playing) {
			this.finish(playing.id, { isCut: true, shouldPlayNext: false });
		}
	}

	private isBusy(): boolean {
		return this.playing !== null || this.queue.items.length > 0;
	}

	readSpeech(): SpeechMoment {
		return {
			isTalking: this.isTalking,
			isMuted: this.queue.isMuted,
			isBusy: this.isBusy(),
			quietSince: this.quietSince,
			hasPage: this.options.hasPage?.() ?? true,
			isListening: this.options.isListening?.() ?? false,
		};
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
		// Filler is the exception: an "Okay." or a progress line after they spoke again is stale.
		this.isTalking = true;
		this.quietSince = this.now();
		this.queue = { ...this.queue, items: this.queue.items.filter((item) => !item.isFiller) };

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
				text: `${readLabel(state, ref)} still needs you.`,
				priority: 'high',
				ref,
				isAsking: !isHeldQuestion(state.sessions[ref]),
				// About an ask: answered meanwhile, the reminder is not said.
				...(state.asks.some((ask) => ask.id === waitKey) ? { askId: waitKey } : {}),
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

	private saysClosedAsk(state: State): boolean {
		const openAsks = readOpenAsks(state);
		const lines = [...(this.playing ? [this.playing.item] : []), ...this.queue.items];

		return lines.some((item) => isClosedAskLine(item, openAsks));
	}

	private asksClosed(): void {
		// Answered while it was being said (a click on the page): the rest of the line asks nothing.
		const openAsks = readOpenAsks(this.options.store.state);
		this.queue = dropClosedAsks(this.queue, openAsks);
		const playing = this.playing;

		if (playing && isClosedAskLine(playing.item, openAsks)) {
			log.info('line cut: its ask closed', { id: playing.item.id, ref: playing.item.ref });
			this.finish(playing.id, { isCut: true });
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

		// Filler is not news: the quiet the meanwhile line waits for goes on through it.
		if (!playing.item.isFiller) {
			this.quietSince = this.now();
		}

		// Only a line the developer heard some of makes the next ack filler on filler.
		if (playing.hasAudio) {
			this.lastSpokeAt = this.now();
		}

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
			about: kind === 'done' ? describeDoneAbout(held.kind === 'line' ? held.text : null) : null,
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

	// Puts the line back at the head of the queue and looks again once its wait is over.
	private holdHead(item: SpeechItem, ms: number): void {
		this.queue = { ...this.queue, items: [item, ...this.queue.items] };
		this.clearTimer(this.headTimer);
		this.headTimer = this.setTimer(() => void this.pump(), ms);
	}

	private async pump(): Promise<void> {
		if (this.playing || this.isTalking) {
			return;
		}

		const { item, queue } = takeNextItem(this.queue, { now: this.now() });
		this.queue = queue;

		if (!item) {
			this.scheduleMeanwhile();

			return;
		}

		// Filler about a session is only worth hearing on its screen: never held for later.
		if (item.isFiller && item.ref && !isOnScreen(this.options.store.state, item.ref)) {
			log.info('filler dropped: off screen', { id: item.id, ref: item.ref });
			void this.pump();

			return;
		}

		// Keeps its place while it is worded, a moment at most; then it plays as it is.
		if (item.wordingUntil !== undefined && item.wordingUntil > this.now()) {
			this.holdHead(item, item.wordingUntil - this.now());

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
			this.holdHead(item, gapLeft);

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
		const synthesized = isShortLine(voiced) && !item.keepsTags ? text : voiced;
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
			hasAudio: false,
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
			...(item.isUpdate ? { isUpdate: true as const } : {}),
			...(item.refs?.length ? { refs: item.refs } : {}),
			...(item.toldAsks?.length ? { toldAsks: item.toldAsks } : {}),
			...(item.isFiller ? { isFiller: true as const } : {}),
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
					playing.hasAudio = true;
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
