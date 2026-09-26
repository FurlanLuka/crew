// Shared by the server and the browser: every type here must stay serializable.

export type SessionStatus = 'stopped' | 'starting' | 'idle' | 'running' | 'blocked';

export type StreamItem = { id: string; at: number } & (
	| { kind: 'user'; text: string }
	| { kind: 'text'; text: string }
	| { kind: 'tool'; name: string; summary: string }
	| { kind: 'tool_result'; ok: boolean; summary: string }
	| { kind: 'diff'; filePath: string; lines: string[] }
	| { kind: 'notice'; text: string }
);

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
	| { kind: 'question'; input: Record<string, unknown>; questions: Question[] }
	| { kind: 'plan'; input: Record<string, unknown>; plan: string }
);

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
	modeOverride: 'default-once' | null;
	costUsd: number;
	error: string | null;
	// Set when the developer's voice started the running turn: a follow-up within FOLLOW_UP_MS interrupts it.
	voiceTurnAt: number | null;
	// No message sent to it since it started: the next one is its first (see buildSessionNote).
	isFresh: boolean;
	// Its last few messages, oldest first, so "what's it doing?" can be answered from elsewhere.
	requests: { text: string; at: number }[];
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

export type View = { kind: 'grid' } | { kind: 'session'; ref: string };

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
}

export interface Setup {
	missing: string[];
}

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
	devServers: Record<string, DevServer[]>;
	devStarting: string[];
	devOffer: DevOffer | null;
	// Per screen (a session ref, or GRID).
	voiceLog: Record<string, VoiceEntry[]>;
}

export type PermissionDecision = 'allow' | 'always' | 'deny';

export type Action =
	// Clicks and voice commands both dispatch exactly these, which keeps every browser and the kernel in sync.
	// note, isSpoken: set only by the server; the gateway schema drops them from clients.
	| { type: 'send'; ref: string; text: string; note?: string; isSpoken?: boolean }
	| { type: 'cancel_queued'; ref: string; queuedId: string }
	| { type: 'answer_permission'; askId: string; decision: PermissionDecision; message?: string }
	| { type: 'answer_question'; askId: string; answers: Record<string, string> }
	| { type: 'answer_plan'; askId: string; isApproved: boolean; message?: string }
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
	| { type: 'dismiss_dev_offer' };

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
	| { type: 'session_started'; ref: string }
	| { type: 'turn_started'; ref: string }
	| { type: 'text_delta'; ref: string; text: string }
	| { type: 'assistant_text'; ref: string; text: string }
	| { type: 'tool'; ref: string; name: string; summary: string }
	| { type: 'tool_result'; ref: string; ok: boolean; summary: string }
	| { type: 'diff'; ref: string; filePath: string; lines: string[] }
	| { type: 'turn_ended'; ref: string; costUsd: number; text: string }
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
	| { type: 'topics_restored'; topics: SavedTopics }
	| { type: 'history_restored'; ref: string; items: StreamItem[] }
	// isSettled: a start's watcher reached its verdict, or a routine look.
	| { type: 'dev_servers'; ref: string; servers: DevServer[]; isSettled: boolean }
	| { type: 'dev_offer'; offer: DevOffer };

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
	// 16-bit PCM at SPEECH_SAMPLE_RATE; hasChime, on a clip's first chunk: play the chime before it.
	| { type: 'audio'; id: string; base64: string; isLast: boolean; hasChime?: boolean }
	// Drops a clip the server cut off.
	| { type: 'audio_cancel'; id: string };

export type ServerMessage =
	| { type: 'snapshot'; state: State }
	| { type: 'input'; stamped: Stamped }
	| SpeechMessage
	// Hands-free was turned off for this tab by the server: another tab took it, or the stream failed.
	| { type: 'listen_off'; reason: string }
	| { type: 'error'; message: string };

export type ClientMessage =
	| { type: 'action'; action: Action }
	| { type: 'utterance'; text: string }
	| { type: 'ptt_start'; sampleRate?: number }
	| { type: 'ptt_stop' }
	| { type: 'listen_start'; sampleRate: number }
	| { type: 'listen_stop' }
	| { type: 'audio_done'; id: string };
