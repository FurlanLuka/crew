// Shared by the server and the browser: every type here must stay serializable.

import type { SendAck } from './ack.js';

export type SessionStatus = 'stopped' | 'starting' | 'idle' | 'running' | 'blocked';

export type StreamItem = { id: string; at: number } & (
	| { kind: 'user'; text: string }
	| { kind: 'text'; text: string }
	| { kind: 'tool'; name: string; summary: string }
	| { kind: 'tool_result'; ok: boolean; summary: string }
	| { kind: 'diff'; filePath: string; lines: string[] }
	| { kind: 'notice'; text: string }
	// An image the session showed: its name in Voice OS's media folder, loaded through /media.
	| { kind: 'image'; name: string; alt: string }
	// A document or artifact the session made or linked (claude.ai, Google Docs, Notion).
	| { kind: 'doc'; url: string; title: string }
	// A question answered by a fork of the session while it worked, beside its turn.
	| {
			kind: 'aside';
			question: string;
			answer: string | null;
			status: AsideStatus;
			// Voice OS context that came with the question: the fork reads it, and so does the turn it may become.
			note?: string;
	  }
);

// withdrawn: replaced by a continuation of the developer's words; it is never said or queued.
export type AsideStatus = 'asking' | 'answered' | 'queued' | 'failed' | 'withdrawn';

export interface Subagent {
	taskId: string;
	agentType: string | null;
	description: string;
	startedAt: number;
	// Its latest tool call, as a short line; null until it makes one.
	step: string | null;
	// A background agent outlives the turn that started it.
	isBackground: boolean;
}

export type GuardedCommand = 'clear' | 'compact';

export interface QueuedMessage {
	id: string;
	text: string;
	at: number;
	// Voice OS context for that Claude alone, never shown as the developer's words.
	note?: string;
	// Said while Claude replied to the last spoken words: that reply is interrupted and this replaces it.
	isFollowUp?: true;
	// Said while the session was starting: its reply is as interruptible as one sent at once.
	isSpoken?: true;
	// An instruction: the turn that handles it must be reported aloud.
	reportOwed?: true;
}

export interface QuestionOption {
	label: string;
	description?: string;
}

export interface Question {
	question: string;
	header?: string;
	options: QuestionOption[];
	multiSelect: boolean;
}

export type PermissionSuggestion = Record<string, unknown>;

export type PendingAsk = { id: string; ref: string; at: number } & (
	| {
			kind: 'permission';
			toolName: string;
			summary: string;
			input: Record<string, unknown>;
			suggestions: PermissionSuggestion[];
	  }
	| {
			kind: 'question';
			input: Record<string, unknown>;
			questions: Question[];
			// Answered so far, by question text: several questions are answered one at a time.
			answers?: Record<string, string>;
	  }
	| { kind: 'plan'; input: Record<string, unknown>; plan: string }
	// Voice OS's own: a /clear or /compact held until the developer says yes. The SDK knows nothing of it.
	| { kind: 'command'; command: GuardedCommand; text: string }
	// Voice OS's own: an instruction that would change a working session's course, held until the
	// developer says whether to stop that work (target: the turn to stop) and switch to it.
	| { kind: 'redirect'; text: string; note?: string; target: string | null }
);

export type HeldAsk = Extract<PendingAsk, { kind: 'command' | 'redirect' }>;
export type SdkAsk = Exclude<PendingAsk, HeldAsk>;

export const isHeldAsk = (ask: PendingAsk): ask is HeldAsk =>
	ask.kind === 'command' || ask.kind === 'redirect';

export const isSdkAsk = (ask: PendingAsk): ask is SdkAsk => !isHeldAsk(ask);

// A held command lapses, so a stray "yes" much later clears nothing.
export const COMMAND_TTL_MS = 2 * 60_000;

export interface Denial {
	id: string;
	ref: string;
	toolName: string;
	summary: string;
	at: number;
}

export interface NeedsUser {
	text: string;
	at: number;
}

// What a session said while the developer looked elsewhere, kept for when they switch to it: its
// latest spoken line, or an ask only announced. missed: earlier lines it replaced.
export type HeldLine = {
	id: string;
	at: number;
	missed: number;
	// The developer was told "<session> is done" or "needs you" about it: that is not said twice.
	isAnnounced: boolean;
} & ({ kind: 'line'; text: string; isAsking: boolean } | { kind: 'ask'; askId: string });

export interface AllowOnce {
	toolName: string;
	summary: string;
	// Asks already open when it was given: answering one of them does not use it up.
	earlierAskIds: string[];
}

export interface Session {
	ref: string;
	label: string;
	branch: string;
	cwd: string;
	dirs: string[];
	isPinned: boolean;
	topic: string | null;
	isTopicPinned: boolean;
	status: SessionStatus;
	queue: QueuedMessage[];
	stream: StreamItem[];
	draft: string;
	needsUser: NeedsUser | null;
	// "Allow it" after auto mode blocked a call: that one call, retried, is approved without asking.
	allowOnce: AllowOnce | null;
	costUsd: number;
	error: string | null;
	// Set when the developer's voice started the running turn: a follow-up within FOLLOW_UP_MS interrupts it.
	voiceTurnAt: number | null;
	// No message sent to it since it started: the next one is its first (see buildSessionNote in tools/send.ts).
	isFresh: boolean;
	// Its last few messages, oldest first, so "what's it doing?" can be answered from elsewhere.
	requests: { text: string; at: number }[];
	subagents: Subagent[];
	// The running turn handles an instruction: its end is reported aloud.
	reportOwed: boolean;
	// The session's own spoken lines already said this turn, so none is said twice.
	spokenInTurn: string[];
	// Which message the running turn is working on: a continuation or a redirect replaces it.
	currentSendId: string | null;
	// Asides replaced by a continuation, remembered past the stream's trim: their answer never plays.
	withdrawnAsides: string[];
	heldLine: HeldLine | null;
	// When its context compaction began; null when none runs. The SDK reports no progress.
	compactingSince: number | null;
	// When its latest spoken line came, if nothing but a question or plan has come since: such a line
	// asked it, and Voice OS does not ask it again.
	lineBeforeAsk: { at: number; text: string } | null;
	// The question or plan that line asked, so Voice OS did not: held as that ask if the developer leaves.
	askedByLine: string | null;
	// The last turn this session reported (remote sessions only): a reconnect reports a newer one once.
	lastTurnId: string | null;
}

export interface VoiceEntry {
	// The kernel's memory of a screen and its side panel's voice log are this same list.
	utterance: string;
	// What changed (see describeToolCall).
	did: string[];
	reply: string;
	at: number;
	isFailed?: true;
	// It asked for nothing.
	isIgnored?: true;
}

// Mission Control has no session ref, so the voice log keys it by this.
export const GRID = 'grid';
export const VOICE_LOG_ENTRIES_KEPT = 8;
// The kernel forgets older exchanges; the panel dims them.
export const VOICE_MEMORY_MS = 30 * 60_000;

export const isRemembered = (entry: VoiceEntry, now: number): boolean =>
	!entry.isIgnored && now - entry.at <= VOICE_MEMORY_MS;

// Speech this soon after the words that started Claude's reply is the rest of that request.
export const FOLLOW_UP_MS = 60_000;

// grid: every session, or one machine's (LOCAL_MACHINE for this Mac). machines: a card per machine,
// home once another machine is added.
export type View =
	| { kind: 'grid'; machine?: string }
	| { kind: 'session'; ref: string }
	| { kind: 'machines' };

// Another machine whose sessions this Voice OS drives, as machines.json keeps it.
export interface MachineConfig {
	// Prefixes its sessions' refs ("vm1:store-front/wrk1"); from the SSH host (machineIdFor).
	id: string;
	host: string;
	// What the developer calls it ("build box"); spoken and shown.
	name: string;
}

// syncing: connected, its snapshot being applied; nothing is sent to it until that is done.
export type MachineStatus = 'connecting' | 'syncing' | 'connected' | 'unreachable' | 'error';

export interface Machine extends MachineConfig {
	status: MachineStatus;
	// Why it is unreachable or failed, for the card and the developer ("run ssh vm1 once").
	detail: string | null;
	since: number;
}

export interface Transcript {
	text: string;
	isFinal: boolean;
	target: string | null;
}

export interface Limits {
	fiveHour: number | null;
	sevenDay: number | null;
	resetsAt: number | null;
}

export interface SpokenLine {
	id: string;
	text: string;
	source: 'kernel' | 'narrator' | 'alert';
	at: number;
	// The session it was about, when it was about one.
	ref?: string;
	// It asked the developer something a bare "yes" answers, not a status line.
	isAsking?: true;
	// When it stopped playing; isCut: before its end (the developer spoke, an alert, a failure).
	endedAt?: number;
	isCut?: true;
}

export interface Setup {
	missing: string[];
}

// The voice gate's dry run: getting its models, learning the developer's voice, then scoring what the
// mic hears against it (nothing is silenced yet). lastScore: the latest delivered turn's.
export type VoiceGateStatus =
	| { phase: 'preparing'; isDownloading: boolean }
	| { phase: 'learning'; seconds: number; of: number }
	| { phase: 'scoring'; lastScore: number | null }
	| { phase: 'unavailable' };

export type DevServerState = 'running' | 'died' | 'not listening' | 'starting';

export interface DevServer {
	name: string;
	port: number;
	url: string | null;
	// crew reports alive/listening; "starting" is Voice OS's own word for a start it is still watching.
	state: DevServerState;
	detail: string | null;
}

export interface DevOffer {
	ref: string;
	servers: string[];
	at: number;
}

// Only the newest offer counts, and it goes stale so a late "yes" fixes nothing.
export const OFFER_TTL_MS = 2 * 60_000;

export const isOfferFresh = (offer: DevOffer | null, now: number): offer is DevOffer =>
	offer !== null && now - offer.at <= OFFER_TTL_MS;

export interface State {
	seq: number;
	sessions: Record<string, Session>;
	order: string[];
	view: View;
	focus: string | null;
	asks: PendingAsk[];
	denials: Denial[];
	transcript: Transcript | null;
	spoken: SpokenLine[];
	limits: Limits;
	setup: Setup;
	voiceGate: VoiceGateStatus | null;
	devServers: Record<string, DevServer[]>;
	devStarting: string[];
	devOffer: DevOffer | null;
	// Per screen (a session ref, or GRID).
	voiceLog: Record<string, VoiceEntry[]>;
	// The developer's last spoken words that still wait or run somewhere (id: what carries them):
	// a continuation said soon after replaces them.
	lastSpokenSend: LastSpokenSend | null;
	// The developer's own notes, by workspace key (shared/notes.ts), newest last.
	notes: Record<string, string[]>;
	// Other machines, by id. Empty: Voice OS drives this Mac alone, as before machines existed.
	machines: Record<string, Machine>;
}

export interface LastSpokenSend {
	ref: string;
	id: string;
	text: string;
	at: number;
}

export type PermissionDecision = 'allow' | 'always' | 'deny';

export type Action =
	// Clicks and voice commands both dispatch exactly these, which keeps every browser and the kernel in sync.
	// note, isSpoken: set only by the server; the gateway schema drops them from clients.
	// aside: set by the kernel for a question a running session should answer beside its work.
	// ack: set by the kernel; spoken from the branch the send actually takes.
	| {
			type: 'send';
			ref: string;
			text: string;
			note?: string;
			isSpoken?: boolean;
			aside?: boolean;
			ack?: SendAck;
			// Set by the kernel: these words finish the developer's previous ones, which they replace;
			// rest is what to send when those already ran their course.
			// isAside: the new part alone would be asked aside (when the first half already ran).
			continues?: { rest: string; isAside?: boolean };
	  }
	| { type: 'cancel_queued'; ref: string; queuedId: string }
	// "I want it now" (or the page's button): the queued words cut the running work and go first.
	| { type: 'promote_queued'; ref: string; queuedId: string }
	// Set by the kernel: the developer takes back words not yet acted on (queued, asked aside, held).
	| { type: 'take_back'; ref: string; id: string }
	// Set by the kernel: the developer heard a held line another way (asked about that session by name).
	| { type: 'held_line_heard'; ref: string; id: string }
	| { type: 'answer_permission'; askId: string; decision: PermissionDecision; message?: string }
	// isSpoken: set by the kernel; the next open question is then read out.
	| {
			type: 'answer_question';
			askId: string;
			answers: Record<string, string>;
			isSpoken?: boolean;
	  }
	| { type: 'answer_plan'; askId: string; isApproved: boolean; message?: string }
	| { type: 'answer_command'; askId: string; isApproved: boolean }
	// message: words added to the answer ("yes, and use staging"; "no, do the seed script instead").
	| { type: 'answer_redirect'; askId: string; isApproved: boolean; message?: string }
	| { type: 'switch_view'; view: View }
	| { type: 'start_session'; ref: string }
	| { type: 'stop_session'; ref: string }
	| { type: 'interrupt'; ref: string }
	| { type: 'allow_denied'; denialId: string }
	| { type: 'dismiss_denial'; denialId: string }
	| { type: 'dismiss_needs_user'; ref: string }
	| { type: 'pin_topic'; ref: string; topic: string }
	| { type: 'dev_start'; ref: string }
	| { type: 'dev_stop'; ref: string }
	| { type: 'dev_restart'; ref: string }
	| { type: 'fix_dev'; ref: string }
	| { type: 'dismiss_dev_offer' }
	| { type: 'add_machine'; host: string; name?: string }
	| { type: 'rename_machine'; id: string; name: string }
	| { type: 'remove_machine'; id: string };

export interface SavedTopic {
	topic: string;
	// topics.json's own key.
	pinned: boolean;
}

export type SavedTopics = Record<string, SavedTopic>;

export interface WorktreeInfo {
	ref: string;
	label: string;
	branch: string;
	cwd: string;
	dirs: string[];
	isPinned: boolean;
}

export type Observation =
	// What the server observes: never sent by a client.
	| { type: 'worktrees'; worktrees: WorktreeInfo[] }
	// The developer's notes of a workspace as they now stand (its newest lines), for the page.
	| { type: 'notes'; workspace: string; lines: string[] }
	// What a session is working on, named after a turn it spoke for itself.
	| { type: 'topic_written'; ref: string; topic: string }
	// A spoken line stopped playing: what the developer heard of it, for the kernel.
	| { type: 'spoken_ended'; lineId: string; isCut: boolean }
	// A line queued while its session was on screen reached play time with the developer elsewhere.
	| { type: 'line_held'; ref: string; text: string; isAsking: boolean }
	// The held line was announced ("<session> is done", "needs you").
	| { type: 'held_line_announced'; ref: string; id: string }
	| { type: 'session_started'; ref: string }
	| { type: 'turn_started'; ref: string }
	| { type: 'text_delta'; ref: string; text: string }
	| { type: 'assistant_text'; ref: string; text: string }
	| { type: 'tool'; ref: string; name: string; summary: string }
	| { type: 'tool_result'; ref: string; ok: boolean; summary: string }
	| { type: 'diff'; ref: string; filePath: string; lines: string[] }
	| { type: 'image'; ref: string; name: string; alt: string }
	| { type: 'doc'; ref: string; url: string; title: string }
	// turnId, head: from a remote session, so a reconnect reports a turn once and the journal needs
	// no git of its own on that machine's paths.
	| {
			type: 'turn_ended';
			ref: string;
			costUsd: number;
			text: string;
			turnId?: string;
			head?: string | null;
	  }
	| { type: 'denied'; ref: string; toolName: string; summary: string }
	| { type: 'ask_opened'; ask: PendingAsk }
	| { type: 'ask_closed'; askId: string }
	| { type: 'worker_exited'; ref: string; error: string | null }
	| { type: 'limits'; limits: Limits }
	| { type: 'narration'; ref: string; needsUser: boolean; text: string; topic: string | null }
	| { type: 'spoken'; text: string; source: SpokenLine['source']; ref?: string; isAsking?: true }
	// Written by the router after it handled an utterance; never from a client.
	| { type: 'voice_logged'; screen: string; entry: VoiceEntry }
	| { type: 'transcript'; transcript: Transcript | null }
	| { type: 'setup'; missing: string[] }
	| { type: 'voice_gate'; status: VoiceGateStatus }
	| { type: 'topics_restored'; topics: SavedTopics }
	| { type: 'history_restored'; ref: string; items: StreamItem[] }
	// isSettled: a start's watcher reached its verdict, or a routine look.
	| { type: 'dev_servers'; ref: string; servers: DevServer[]; isSettled: boolean }
	| { type: 'dev_offer'; offer: DevOffer }
	| {
			type: 'subagent_started';
			ref: string;
			taskId: string;
			agentType: string | null;
			description: string;
			isBackground: boolean;
	  }
	| { type: 'subagent_step'; ref: string; taskId: string; step: string }
	| { type: 'subagent_backgrounded'; ref: string; taskId: string }
	| { type: 'subagent_ended'; ref: string; taskId: string }
	// A side question settled: answered, or handed back to the session's queue.
	| {
			type: 'aside_settled';
			ref: string;
			itemId: string;
			// Carried here too: the item may have left the stream by the time the answer comes.
			question: string;
			status: Exclude<AsideStatus, 'asking'>;
			answer: string | null;
			// The fork found the question means the current work should change: a switch, not a queue.
			isChangingWork?: boolean;
	  }
	// /clear (or /reset, /new) started a new conversation in the same process.
	| { type: 'conversation_reset'; ref: string }
	// The session's context is being compacted (true), or that ended (false).
	| { type: 'compacting'; ref: string; isCompacting: boolean }
	| { type: 'session_notice'; ref: string; text: string }
	// A held /clear or /compact went unanswered for COMMAND_TTL_MS.
	| { type: 'command_expired'; askId: string }
	// machines.json as it now stands.
	| { type: 'machines'; machines: MachineConfig[] }
	| { type: 'machine_status'; id: string; status: MachineStatus; detail?: string | null }
	// A machine came back: what its snapshot says, applied as one step without speaking, then its
	// queues move again (remote/resync.ts plans the inputs).
	| { type: 'machine_resynced'; id: string; inputs: Observation[] };

export type Input = Action | Observation;

export interface Stamped {
	// The store stamps every input, so a browser replaying the same stamped inputs reaches the same state.
	seq: number;
	at: number;
	id: string;
	input: Input;
}

export const SPEECH_SAMPLE_RATE = 24_000;

export type SpeechMessage =
	// 16-bit PCM at SPEECH_SAMPLE_RATE; hasChime, on a clip's first chunk: play the chime before it
	// (chime 'needs': the rising one of a session that needs the developer).
	| {
			type: 'audio';
			id: string;
			base64: string;
			isLast: boolean;
			hasChime?: boolean;
			chime?: 'needs';
	  }
	// Drops a clip the server cut off.
	| { type: 'audio_cancel'; id: string };

// How the mic is used. push: held to talk. on-demand: always listening, acting only on what follows
// "Voice OS". hands-free: always listening, every turn is acted on.
export type ListenMode = 'push' | 'on-demand' | 'hands-free';

export type ListeningMode = Exclude<ListenMode, 'push'>;

export const LISTEN_MODES: ListenMode[] = ['push', 'on-demand', 'hands-free'];

export const isListenMode = (value: unknown): value is ListenMode =>
	LISTEN_MODES.some((mode) => mode === value);

export type ServerMessage =
	// serverId: this server process. A tab that sees it change is talking to a restarted, possibly
	// newer Voice OS while still running the old page, and reloads.
	| { type: 'snapshot'; state: State; serverId?: string }
	| { type: 'input'; stamped: Stamped }
	| SpeechMessage
	// Listening was turned off for this tab by the server: another tab took it, or the stream failed.
	| { type: 'listen_off'; reason: string }
	// A listening mode was turned on for this tab by voice.
	| { type: 'listen_on'; mode: ListeningMode }
	// On demand: "Voice OS" was heard and a turn is open (true), or it closed (false).
	| { type: 'listen_state'; isAwake: boolean }
	// On demand: speech without "Voice OS" was heard and left alone.
	| { type: 'heard_ignored' }
	// "Open the doc": opened in this tab's browser, since the developer may be anywhere.
	| { type: 'open_url'; url: string; title: string }
	| { type: 'error'; message: string };

export type ClientMessage =
	| { type: 'action'; action: Action }
	| { type: 'utterance'; text: string }
	| { type: 'ptt_start'; sampleRate?: number }
	| { type: 'ptt_stop' }
	// Debug only (VOICEOS_DEBUG_SPEECH=1): words taken as heard, for demos and screenshots.
	| { type: 'simulate_speech'; text: string; holdMs?: number }
	// No mode: a tab from before the modes, which only knew hands-free.
	| { type: 'listen_start'; sampleRate: number; mode?: ListeningMode }
	| { type: 'listen_stop' }
	| { type: 'audio_done'; id: string };
