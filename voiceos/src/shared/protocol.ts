// Shared by the server and the browser: every type here must stay serializable.

import type { SendAck } from './ack.js';

export type SessionStatus = 'stopped' | 'starting' | 'idle' | 'running' | 'blocked';

// A user item's isApproval: Voice OS's retry of a call the developer allowed once; still the turn's
// opening words.
export type StreamItem = { id: string; at: number } & (
	| { kind: 'user'; text: string; isApproval?: true }
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
	// Voice OS's own words (a denied call's retry), not the developer's: "send them all now" leaves it.
	isRetry?: true;
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
	// The setup session (crew setup, cwd home): not the active set. The name is on the wire to remotes.
	isPinned: boolean;
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

// The screens that are not a session (Active, Activate, Settings) share one voice log, keyed by this.
export const HOME_SCREEN = 'home';
export const VOICE_LOG_ENTRIES_KEPT = 8;
// The kernel forgets older exchanges; the panel dims them.
export const VOICE_MEMORY_MS = 30 * 60_000;

export const isRemembered = (entry: VoiceEntry, now: number): boolean =>
	!entry.isIgnored && now - entry.at <= VOICE_MEMORY_MS;

// Speech this soon after the words that started Claude's reply is the rest of that request.
export const FOLLOW_UP_MS = 60_000;

// active: the developer's active sessions, across machines (home). activate: every worktree to
// activate, on every machine or one (LOCAL_MACHINE for this Mac). settings: Voice OS's own.
// A session's from: opened from Active, so its tabs are the active sessions and Esc goes back there.
export type View =
	| { kind: 'active' }
	| { kind: 'session'; ref: string; from?: 'active' }
	| { kind: 'activate'; machine?: string }
	| { kind: 'settings' };

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

export interface ViewHistoryEntry {
	view: View;
	// Its session was running when the developer left it: stopped since, "go back" passes it over.
	wasLive?: true;
}

export const VIEW_HISTORY_KEPT = 5;

export interface MeanwhileItem {
	ref: string;
	kind: 'done' | 'needs';
	about: string | null;
	at: number;
	// A question, plan or permission it stands for: its words are read from the live ask when said.
	askId?: string;
}

// An ask the meanwhile line said in full (a permission, a short question): heard, it is answered like
// any question asked aloud.
export interface ToldAsk {
	ref: string;
	askId: string;
}

// Quiet before the waiting updates are said: push to talk is quiet the moment the key is up;
// listening needs a longer gap to be sure the developer finished.
export const MEANWHILE_QUIET_MS = 8_000;
export const MEANWHILE_QUIET_LISTENING_MS = 12_000;
// A session blocked on the developer waits only for a breath, not for the quiet.
export const MEANWHILE_ASK_QUIET_MS = 3_000;
// An update never waits longer than this: it plays at the next gap, however short.
export const MEANWHILE_MAX_WAIT_MS = 50_000;

export interface TargetAsk {
	ref: string;
	// The session on screen when the words were said: where they go on a no, or on silence.
	screen: string;
	text: string;
	at: number;
	// When the question finished playing: its window for an answer starts here, not in the queue.
	heardAt?: number;
}

// Asked and answered in a breath; silence keeps the words on the screen.
export const TARGET_ASK_MS = 8_000;
// A question still waiting to be said is given up on after this, heard or not.
export const QUESTION_UNHEARD_MS = 30_000;

// What a yes does. switch (the default): go there. activate: "<X> isn't active. Activate it?" — words
// said to it wait in its queue and go once it is up. deactivate: "<X> is working. Deactivate anyway?".
export type SwitchOfferKind = 'switch' | 'activate' | 'deactivate';

export interface SwitchOffer {
	ref: string;
	at: number;
	heardAt?: number;
	kind?: SwitchOfferKind;
	// An activate asked for a switch: a yes activates it and goes there.
	thenSwitch?: true;
}

// Answered at once or not at all: a later "yes" belongs to something else.
// The most text one message carries: the gateway refuses more, so the page never sends it.
export const MAX_TEXT_CHARS = 20_000;

export const SWITCH_OFFER_MS = 8_000;

// Counted from when it was heard: a question still queued behind a long answer has not been asked,
// and words said before it was asked at all are never its answer.
export const isSwitchOfferFresh = (offer: SwitchOffer | null, now: number): offer is SwitchOffer =>
	offer !== null &&
	now >= offer.at &&
	(offer.heardAt === undefined
		? now - offer.at < QUESTION_UNHEARD_MS
		: now - offer.heardAt < SWITCH_OFFER_MS);

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
	// The session's own answer to the developer, not an announcement, reminder or acknowledgement.
	isAnswer?: true;
	// No tab played it: nobody heard it.
	isUnplayed?: true;
	// Voice OS telling the developer about other sessions' updates ("checkout needs you: …", the
	// meanwhile line). refs: every session the meanwhile line named.
	isUpdate?: true;
	refs?: string[];
	toldAsks?: ToldAsk[];
	// Voice OS's own filler (an instant "Okay."): never its question, never what the
	// developer heard before, never a session's line.
	isFiller?: true;
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
	// "Switch to checkout?", asked aloud by Voice OS: a yes switches, anything else lets it go.
	switchOffer: SwitchOffer | null;
	// Where the developer has been, newest first: "go back".
	viewHistory: ViewHistoryEntry[];
	// "For checkout?": words that named checkout without clearly speaking to it, held until the
	// developer says whether they were for it or for the screen.
	targetAsk: TargetAsk | null;
	// Other sessions' "is done" / "needs you", waiting for a quiet moment to be said as one line.
	meanwhile: MeanwhileItem[];
	// Per screen (a session ref, or HOME_SCREEN).
	voiceLog: Record<string, VoiceEntry[]>;
	// The developer's last spoken words that still wait or run somewhere (id: what carries them):
	// a continuation said soon after replaces them.
	lastSpokenSend: LastSpokenSend | null;
	// The developer's own notes, by workspace key (shared/notes.ts), newest last.
	notes: Record<string, string[]>;
	// Other machines, by id. Empty: Voice OS drives this Mac alone, as before machines existed.
	machines: Record<string, Machine>;
	// Active session refs, in the order activated, from any machine; read through shared/active.ts.
	// An active ref outlives its session (a machine out of reach): it starts when it is back.
	active: string[];
	// The developer's own names for sessions, by full ref; Voice OS's alone, crew never sees them.
	names: Record<string, string>;
	// What speech-to-text expects the developer to speak (Soniox language hints).
	languages: string[];
	// The Discord voice channel (crew server discord setup), when set up; null otherwise.
	discord: DiscordPresence | null;
	// Activations of worktrees crew has made but Voice OS has not listed yet (Set up's "Open Voice
	// OS" right after creating one): applied when a worktrees list has them, dropped after a while.
	pendingActivations: PendingActivation[];
}

export interface PendingActivation {
	ref: string;
	at: number;
	isOpening: boolean;
}

export interface DiscordPresence {
	// The bot is in the channel.
	isConnected: boolean;
	// The owner is in it too: Voice OS listens and speaks there, not in a tab.
	isOwnerIn: boolean;
	// False when speech-to-text gave up (the stream kept dropping, no Soniox key): in the channel but unheard.
	isHearing: boolean;
	channelName: string;
	mode: ListeningMode;
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
			// Set by the kernel: the developer said to send these right now, so they replace the running turn.
			isNow?: boolean;
			// Set by the server with isSpoken: the screen the words were said on. The developer may click
			// away while the kernel thinks; the words were still said to that screen.
			saidOn?: string | null;
	  }
	| { type: 'cancel_queued'; ref: string; queuedId: string }
	// "I want it now" (or the page's button): the queued words cut the running work and go first.
	| { type: 'promote_queued'; ref: string; queuedId: string }
	// "Send both now": every queued message of the developer's goes now, merged into one, in order.
	| { type: 'promote_all_queued'; ref: string }
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
	// The page's X on a question: Claude's AskUserQuestion is denied, saying the developer declined.
	| { type: 'decline_question'; askId: string }
	| { type: 'answer_plan'; askId: string; isApproved: boolean; message?: string }
	| { type: 'answer_command'; askId: string; isApproved: boolean }
	// message: words added to the answer ("yes, and use staging"; "no, do the seed script instead").
	| { type: 'answer_redirect'; askId: string; isApproved: boolean; message?: string }
	// announce: Voice OS made the switch (a voice command), so it says so; a click is silent.
	// skipHeld: the switch also sends a question, so the old held update is not replayed first.
	| { type: 'switch_view'; view: View; announce?: true; skipHeld?: true }
	| { type: 'go_back' }
	// announce: activated by voice, so Voice OS offers the switch; a click is silent. open: show it
	// too (Set up's "Open Voice OS"); a worktree Voice OS has not listed yet is held until it has.
	| { type: 'activate'; ref: string; announce?: true; open?: true }
	| { type: 'deactivate'; ref: string }
	// isCorrection: the developer's words went there by mistake; Voice OS says it stopped it.
	| { type: 'interrupt'; ref: string; isCorrection?: true }
	| { type: 'allow_denied'; denialId: string }
	| { type: 'dismiss_denial'; denialId: string }
	| { type: 'dev_start'; ref: string }
	| { type: 'dev_stop'; ref: string }
	| { type: 'dev_restart'; ref: string }
	| { type: 'fix_dev'; ref: string }
	| { type: 'dismiss_dev_offer' }
	| { type: 'add_machine'; host: string; name?: string }
	| { type: 'rename_machine'; id: string; name: string }
	| { type: 'remove_machine'; id: string }
	// An empty name clears it: the session shows its crew label again.
	| { type: 'rename_session'; ref: string; name: string }
	// The languages the developer speaks, from the listening menu (and loaded at boot).
	| { type: 'set_languages'; languages: string[] }
	// "What did I miss?", or the quiet came: the waiting updates are said as one line.
	| { type: 'play_meanwhile' }
	// Voice OS asks "Switch to X?" aloud (a kernel tool found X only announced), or with a kind
	// "X isn't active. Activate it?" or "X is working. Deactivate anyway?".
	| {
			type: 'offer_switch';
			ref: string;
			kind?: SwitchOfferKind;
			thenSwitch?: true;
	  }
	// Voice OS asks "For X?" and holds the words until the developer says which.
	| { type: 'ask_which'; ref: string; screen: string; text: string }
	// toTarget: yes, send them to X; otherwise they are kept on the screen. `at` names the ask.
	| { type: 'settle_target'; at: number; toTarget: boolean };

export interface WorktreeInfo {
	ref: string;
	label: string;
	branch: string;
	cwd: string;
	dirs: string[];
	// The setup session; see Session.isPinned.
	isPinned: boolean;
}

export type Observation =
	// What the server observes: never sent by a client.
	| { type: 'worktrees'; worktrees: WorktreeInfo[] }
	// The developer's notes of a workspace as they now stand (its newest lines), for the page.
	| { type: 'notes'; workspace: string; lines: string[] }
	// What a session is working on, named after a turn it spoke for itself.
	// A spoken line stopped playing: what the developer heard of it, for the kernel.
	| { type: 'spoken_ended'; lineId: string; isCut: boolean; isUnplayed?: true }
	| {
			type: 'meanwhile_added';
			ref: string;
			kind: MeanwhileItem['kind'];
			about: string | null;
			askId?: string;
	  }
	// isLapse: the timer's, which leaves an offer still fresh (heard later than it was queued) alone.
	| { type: 'switch_offer_closed'; at: number; isLapse?: true }
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
	| { type: 'narration'; ref: string; needsUser: boolean; text: string }
	| {
			type: 'spoken';
			text: string;
			source: SpokenLine['source'];
			ref?: string;
			isAsking?: true;
			isAnswer?: true;
			isUpdate?: true;
			refs?: string[];
			toldAsks?: ToldAsk[];
			isFiller?: true;
	  }
	// The Discord bridge's own state (connected, owner in the channel); null when not set up.
	| { type: 'discord_presence'; presence: DiscordPresence | null }
	// Written by the router after it handled an utterance; never from a client.
	| { type: 'voice_logged'; screen: string; entry: VoiceEntry }
	| { type: 'transcript'; transcript: Transcript | null }
	| { type: 'setup'; missing: string[] }
	// The view saved before a restart, put back without a word: nobody asked to look anywhere.
	| { type: 'restore_view'; view: View }
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
	| { type: 'machine_resynced'; id: string; inputs: Observation[] }
	// The active set saved before a restart, merged with any activated since boot.
	| { type: 'active_loaded'; refs: string[] }
	// The names saved before a restart.
	| { type: 'names_loaded'; names: Record<string, string> };

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
	// A dictation that had nowhere to go (no session on screen, or it waits on an answer), or a press
	// whose release never came: its words come back into this tab's input, to send from there.
	| { type: 'dictation_kept'; text: string; reason: string }
	// "Open the doc": opened in this tab's browser, since the developer may be anywhere.
	| { type: 'open_url'; url: string; title: string }
	| { type: 'error'; message: string };

export type ClientMessage =
	| { type: 'action'; action: Action }
	| { type: 'utterance'; text: string }
	// dictation: a press held open for a brain dump, sent word for word to the session on screen.
	| { type: 'ptt_start'; sampleRate?: number; dictation?: true }
	| { type: 'ptt_stop' }
	// Throws away the dictation under way: nothing is sent.
	| { type: 'ptt_cancel' }
	// Debug only (VOICEOS_DEBUG_SPEECH=1): words taken as heard, for demos and screenshots.
	| { type: 'simulate_speech'; text: string; holdMs?: number }
	// No mode: a tab from before the modes, which only knew hands-free.
	| { type: 'listen_start'; sampleRate: number; mode?: ListeningMode }
	| { type: 'listen_stop' }
	| { type: 'audio_done'; id: string }
	// The listening menu while the owner is on Discord: how the Discord channel listens.
	| { type: 'discord_listen'; mode: ListeningMode };
