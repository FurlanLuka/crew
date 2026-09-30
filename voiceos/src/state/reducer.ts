import { followExchange, pruneExchange, readSubject } from './exchange.js';
import { sayRef } from './helpers.js';
import { isTargetInput, reduceTargetAsk } from './target-ask.js';
import {
	decideGoBack,
	describeGoBack,
	describeSwitching,
	isSameView,
	pruneViewHistory,
	pushViewHistory,
} from './view-history.js';
import {
	GRID,
	VOICE_LOG_ENTRIES_KEPT,
	type PendingAsk,
	type Session,
	type Stamped,
	type State,
	type View,
	type VoiceEntry,
	type WorktreeInfo,
} from '../shared/protocol.js';
import { isAskInput, reduceAsk, restoreAutoEffects, settleAsksForSession } from './asks.js';
import { isAsideInput, reduceAside } from './aside.js';
import { isCommandInput, reduceCommand } from './commands.js';
import { findRedirectAsk, isRedirectInput, queueHeldRedirect, reduceRedirect } from './redirect.js';
import { hasBackgroundWork, isSubagentInput, reduceSubagent } from './subagents.js';
import { isDevInput, reduceDev } from './dev.js';
import {
	createStreamItem,
	dispatchQueueHead,
	pushNotice,
	markSelfStarted,
	pushStreamItem,
	startWorker,
	STREAM_ITEMS_KEPT,
	truncateText,
	updateSession,
	withoutEffects,
	isShownAlready,
} from './helpers.js';
import { hasFollowUpWaiting, promoteAllQueued, promoteQueued } from './delivery.js';
import { reduceTakeBack } from './take-back.js';
import { reduceSend } from './send.js';
import type { SpeechPriority } from '../speech/queue.js';
import { readSpokenTag, type SpokenTag } from '../shared/spoken-tags.js';
import { speakNewTag } from './spoken-lines.js';
import { cleanSessionLine } from '../shared/spoken.js';
import { clearHeldLine, holdLine, isOnScreen, replayHeldLine } from './held-lines.js';
import { describeSwitch, guardUnreachable, isMachineInput, reduceMachine } from './machines.js';
import { HOME_VIEW } from '../shared/machines.js';
import { machineOf, readMachine } from '../shared/machine-ref.js';
import { isPinInput, reducePin, toShownView } from './pins.js';
import { isNameInput, reduceName } from './names.js';

export const SPOKEN_LINES_KEPT = 20;

export type AskResult =
	| {
			behavior: 'allow';
			updatedInput: Record<string, unknown>;
			updatedPermissions?: Record<string, unknown>[];
	  }
	| { behavior: 'deny'; message: string };

export type Effect =
	| { type: 'worker_start'; ref: string }
	| { type: 'worker_send'; ref: string; text: string; note?: string }
	| { type: 'worker_stop'; ref: string }
	// reason: 'follow-up' when the developer's own spoken follow-up cut the reply.
	| { type: 'worker_interrupt'; ref: string; reason?: 'follow-up' }
	| { type: 'worker_set_mode'; ref: string; mode: 'default' | 'auto' }
	| { type: 'resolve_ask'; ref: string; askId: string; result: AskResult }
	// spoken: the session's own line for the turn's final message; null sends it to the narrator.
	| {
			type: 'narrate';
			ref: string;
			text: string;
			asked: string | null;
			isOwed: boolean;
			spoken: SpokenTag | null;
			isSpokenAlready: boolean;
			// Its final line was held while the developer looked elsewhere.
			isHeld: boolean;
			// Background sub-agents still work: the turn ended, the work did not.
			hasBackgroundAgents: boolean;
			// A remote session's commit, read there: git never runs here on another machine's path.
			head?: string | null;
			// Reported while its machine came back: recorded and held, not said (the recap says it).
			isQuiet?: boolean;
	  }
	// A side question to run in a fork of the session, and its answer to say.
	| { type: 'side_answer'; ref: string; itemId: string; question: string; note?: string }
	| { type: 'narrate_aside'; ref: string; question: string; answer: string }
	// Lets a held command lapse: command_expired comes back after COMMAND_TTL_MS.
	| { type: 'expire_command'; askId: string }
	// reply: the answer to what the developer just said (no chime before it).
	| {
			type: 'speak';
			text: string;
			source: 'kernel' | 'narrator' | 'alert';
			isReply?: boolean;
			ref?: string;
			isAsking?: boolean;
			// Said with the session's name in front unless it is on screen.
			isNamed?: boolean;
			// Default: alert for alerts, normal otherwise.
			priority?: SpeechPriority;
			// A line the developer is waiting for: nothing newer replaces it before it plays.
			isOwed?: boolean;
			// Voice OS saying it passed words on: it replaces nothing still waiting to be said.
			isAck?: boolean;
			// A session that needs the developer: its own rising chime.
			chime?: 'needs';
			// Held instead if its session is off screen when it plays (a long line).
			isHoldable?: boolean;
			// The session's own answer: heard to the end, it keeps the conversation with it going.
			isAnswer?: boolean;
	  }
	// The developer spoke to this session again: its lines still waiting to be said (older than
	// before) are out of date. They stay on the page.
	| { type: 'drop_speech'; ref: string; before: number }
	| { type: 'dev'; ref: string; action: 'start' | 'stop' | 'restart' }
	| { type: 'fix_dev'; ref: string; servers: string[] }
	// crew voice machines writes it to machines.json (crew is the one writer, under its lock).
	| { type: 'machines_changed'; change: MachineChange };

export type MachineChange =
	| { kind: 'add'; host: string; name: string }
	| { kind: 'rename'; id: string; name: string }
	| { kind: 'remove'; id: string };

export interface ReducerResult {
	state: State;
	effects: Effect[];
}

export const createInitialState = (): State => ({
	seq: 0,
	sessions: {},
	order: [],
	view: HOME_VIEW,
	focus: null,
	exchange: null,
	viewHistory: [],
	targetAsk: null,
	asks: [],
	denials: [],
	transcript: null,
	spoken: [],
	limits: { fiveHour: null, sevenDay: null, resetsAt: null },
	setup: { missing: [] },
	devServers: {},
	devStarting: [],
	devOffer: null,
	switchOffer: null,
	voiceLog: {},
	lastSpokenSend: null,
	notes: {},
	machines: {},
	pinned: [],
	names: {},
});

export const createSession = (info: WorktreeInfo): Session => ({
	...info,
	topic: null,
	isTopicPinned: false,
	status: 'stopped',
	queue: [],
	stream: [],
	draft: '',
	needsUser: null,
	allowOnce: null,
	costUsd: 0,
	error: null,
	voiceTurnAt: null,
	isFresh: false,
	requests: [],
	subagents: [],
	compactingSince: null,
	reportOwed: false,
	spokenInTurn: [],
	currentSendId: null,
	heldLine: null,
	lineBeforeAsk: null,
	askedByLine: null,
	withdrawnAsides: [],
	lastTurnId: null,
});

// The tools that open a question or a plan: they follow the line that announced them.
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

const describeUnfinished = (ref: string): Effect => ({
	type: 'speak',
	text: 'Stopped before it finished.',
	source: 'kernel',
	ref,
	isNamed: true,
	priority: 'high',
	isOwed: true,
});

const findAskKind = (state: State, askId: string): PendingAsk['kind'] | null =>
	state.asks.find((ask) => ask.id === askId)?.kind ?? null;

const moveHeldRedirectAhead = (state: State, ref: string, stamped: Stamped): State => {
	const ask = findRedirectAsk(state, ref);

	return ask ? queueHeldRedirect({ state, ask, at: stamped.at, isFirst: true }) : state;
};

const MAX_LOGGED_CHARS = 500;

const capEntry = (entry: VoiceEntry): VoiceEntry => {
	// Typed text can be 20k characters; the log and the kernel's memory need the gist.
	return {
		...entry,
		utterance: truncateText(entry.utterance, MAX_LOGGED_CHARS),
		reply: truncateText(entry.reply, MAX_LOGGED_CHARS),
	};
};

const findLastUserText = (session: Session): string | null => {
	for (let i = session.stream.length - 1; i >= 0; i--) {
		const item = session.stream[i];

		if (item?.kind === 'user') {
			return item.text;
		}
	}

	return null;
};

const reconcileWorktrees = (state: State, worktrees: WorktreeInfo[]): State => {
	const sessions: Record<string, Session> = {};

	for (const info of worktrees) {
		const existing = state.sessions[info.ref];

		sessions[info.ref] = existing ? { ...existing, ...info } : createSession(info);
	}

	// A worktree removed from crew while its worker runs stays until the worker exits.
	for (const [ref, session] of Object.entries(state.sessions)) {
		if (!sessions[ref] && session.status !== 'stopped') {
			sessions[ref] = session;
		}
	}

	// This Mac's sessions first, then each machine's; within one, the setup session leads.
	const order = Object.values(sessions)
		.sort(
			(left, right) =>
				Number(machineOf(left.ref) !== null) - Number(machineOf(right.ref) !== null) ||
				(machineOf(left.ref) ?? '').localeCompare(machineOf(right.ref) ?? '') ||
				Number(right.isPinned) - Number(left.isPinned) ||
				left.ref.localeCompare(right.ref),
		)
		.map((session) => session.ref);
	const gone = state.view.kind === 'session' && !sessions[state.view.ref] ? state.view : null;
	// A session opened from Pinned falls back to Pinned, where its pin stays as a "gone" tile.
	const view: View = !gone
		? state.view
		: gone.from === 'pinned'
			? { kind: 'pinned' }
			: { kind: 'grid', machine: readMachine(gone.ref) };
	const focus = state.focus && sessions[state.focus] ? state.focus : null;
	const voiceLog = Object.fromEntries(
		Object.entries(state.voiceLog).filter(([screen]) => screen === GRID || sessions[screen]),
	);

	const isKept = (ref: string) => Boolean(sessions[ref]);
	const exchange = pruneExchange(state.exchange, isKept);
	const viewHistory = pruneViewHistory(state.viewHistory, isKept);

	return { ...state, sessions, order, view, focus, exchange, viewHistory, voiceLog };
};

// Its lines are said as they come: on screen, or the session the developer talks with elsewhere.
const isHeardNow = (state: State, ref: string, at: number): boolean =>
	isOnScreen(state, ref) || readSubject(state, at) === ref;

// A session that is gone cannot be shown: null leaves the screen where it is. The view left goes
// on the history, for "go back", unless this is a restore or a step back itself.
const showView = (state: State, view: View, { isRemembered = true } = {}): State | null => {
	if (view.kind === 'session' && !state.sessions[view.ref]) {
		return null;
	}

	const shown = toShownView(state, view);

	return {
		...state,
		view: shown,
		focus: view.kind === 'session' ? view.ref : state.focus,
		viewHistory: isRemembered ? pushViewHistory(state, shown) : state.viewHistory,
	};
};

const goBack = (state: State, at: number): ReducerResult => {
	const decision = decideGoBack({ state, now: at });

	if (decision.kind === 'empty') {
		return { state, effects: [describeGoBack(state, decision)] };
	}

	const shown = showView({ ...state, viewHistory: decision.rest }, decision.view, {
		isRemembered: false,
	});

	if (!shown) {
		return {
			state,
			effects: [describeGoBack(state, { kind: 'empty', skipped: decision.skipped })],
		};
	}

	// The conversation they had there comes back with it, while it is still live.
	const restored = { ...shown, exchange: decision.exchange, switchOffer: null };
	const said = describeGoBack(state, decision);

	if (decision.view.kind !== 'session') {
		return { state: restored, effects: [said] };
	}

	const replayed = replayHeldLine(restored, decision.view.ref);

	return { state: replayed.state, effects: [said, ...replayed.effects] };
};

const reduceInput = (state: State, stamped: Stamped): ReducerResult => {
	const { input } = stamped;

	if (isTargetInput(input)) {
		return reduceTargetAsk(state, input, stamped);
	}

	if (isMachineInput(input)) {
		return reduceMachine(state, input, stamped, reduceInput);
	}

	// Pins are this Voice OS's own: they never reach a machine, reachable or not.
	if (isPinInput(input)) {
		return reducePin(state, input);
	}

	// Names are this Voice OS's own too: a session out of reach is renamed like any other.
	if (isNameInput(input)) {
		return reduceName(state, input);
	}

	const unreachable = guardUnreachable(state, input, stamped);

	if (unreachable) {
		return unreachable;
	}

	// Answering what a session asks is not a message a continuation could extend.
	const answered = input.type.startsWith('answer_') ? { ...state, lastSpokenSend: null } : state;

	if (isAskInput(input)) {
		return reduceAsk(answered, input, stamped);
	}

	if (isDevInput(input)) {
		return reduceDev(state, input, stamped);
	}

	if (isRedirectInput(input)) {
		return reduceRedirect(answered, input, stamped);
	}

	// A held switch lapses on the same timer as a held command.
	if (input.type === 'command_expired' && findAskKind(state, input.askId) === 'redirect') {
		return reduceRedirect(state, input, stamped);
	}

	if (isCommandInput(input)) {
		return reduceCommand(answered, input, stamped);
	}

	if (isAsideInput(input)) {
		return reduceAside(state, input, stamped);
	}

	if (isSubagentInput(input)) {
		return reduceSubagent(state, input, stamped.at);
	}

	switch (input.type) {
		case 'worktrees':
			return withoutEffects(reconcileWorktrees(state, input.worktrees));

		case 'send':
			return reduceSend(state, input, stamped);

		case 'cancel_queued':
			return withoutEffects(
				updateSession(state, input.ref, (session) => ({
					...session,
					queue: session.queue.filter((message) => message.id !== input.queuedId),
				})),
			);

		case 'take_back':
			return reduceTakeBack(state, input);

		case 'promote_queued':
			return promoteQueued({ state, ref: input.ref, queuedId: input.queuedId, stamped });
		case 'promote_all_queued':
			return promoteAllQueued({ state, ref: input.ref, stamped });

		case 'switch_view': {
			const { view } = input;
			const shown = showView(state, view);

			if (!shown) {
				return withoutEffects(state);
			}

			const switched =
				view.kind === 'session' && !input.skipHeld
					? replayHeldLine(shown, view.ref)
					: view.kind === 'session'
						? { state: shown, effects: [] }
						: { state: shown, effects: describeSwitch(state, view) };

			// Said first: whatever plays there next is heard as coming from there.
			return input.announce && !isSameView(state.view, shown.view)
				? { ...switched, effects: [describeSwitching(state, shown.view), ...switched.effects] }
				: switched;
		}

		case 'go_back':
			return goBack(state, stamped.at);

		case 'restore_view':
			return withoutEffects(showView(state, input.view, { isRemembered: false }) ?? state);

		case 'start_session':
			return state.sessions[input.ref]?.status === 'stopped'
				? startWorker(state, input.ref)
				: withoutEffects(state);

		case 'stop_session': {
			const session = state.sessions[input.ref];

			if (!session || session.status === 'stopped') {
				return withoutEffects(state);
			}

			const settled = settleAsksForSession(state, input.ref, 'The session was stopped.');

			return {
				state: updateSession(settled.state, input.ref, (current) => ({
					...current,
					status: 'stopped',
					queue: [],
					draft: '',
					voiceTurnAt: null,
					compactingSince: null,
					allowOnce: null,
					reportOwed: false,
					currentSendId: null,
					heldLine: null,
					lineBeforeAsk: null,
					askedByLine: null,
				})),
				effects: [...settled.effects, { type: 'worker_stop', ref: input.ref }],
			};
		}

		case 'interrupt': {
			const session = state.sessions[input.ref];

			if (!session || (session.status !== 'running' && session.status !== 'blocked')) {
				return withoutEffects(state);
			}

			const settled = settleAsksForSession(state, input.ref, 'The user interrupted.');

			return {
				state: updateSession(settled.state, input.ref, (current) => ({
					...current,
					queue: [],
					voiceTurnAt: null,
					// The developer stopped the work: there is nothing to report, nor to replay.
					reportOwed: false,
					compactingSince: null,
					allowOnce: null,
					currentSendId: null,
					heldLine: null,
					lineBeforeAsk: null,
					askedByLine: null,
				})),
				effects: [
					...settled.effects,
					...(input.isCorrection
						? [
								{
									type: 'speak' as const,
									text: `Stopped ${sayRef(state, input.ref)}.`,
									source: 'kernel' as const,
									isReply: true,
									isAck: true,
									priority: 'high' as const,
								},
							]
						: []),
					{ type: 'worker_interrupt', ref: input.ref },
					// An allowance still waiting goes with the work it was for.
					...restoreAutoEffects(session),
				],
			};
		}

		case 'dismiss_needs_user':
			return withoutEffects(
				updateSession(state, input.ref, (session) => ({
					...session,
					needsUser: null,
					heldLine: null,
				})),
			);

		case 'pin_topic':
			return withoutEffects(
				updateSession(state, input.ref, (session) => ({
					...session,
					topic: input.topic.trim() || null,
					isTopicPinned: Boolean(input.topic.trim()),
				})),
			);

		case 'topics_restored': {
			const restored = Object.entries(input.topics).reduce(
				(next, [ref, saved]) =>
					updateSession(next, ref, (session) =>
						session.topic
							? session
							: { ...session, topic: saved.topic, isTopicPinned: saved.pinned },
					),
				state,
			);

			return withoutEffects(restored);
		}

		case 'session_started': {
			if (!state.sessions[input.ref]) {
				return withoutEffects(state);
			}

			// Sub-agents belong to a process: a new one starts with none.
			const ready = updateSession(state, input.ref, (session) => ({
				...session,
				status: 'idle',
				error: null,
				subagents: [],
				compactingSince: null,
			}));

			return dispatchQueueHead(ready, input.ref, stamped);
		}

		case 'turn_started':
			return withoutEffects(
				updateSession(state, input.ref, (session) =>
					session.status === 'blocked' ? session : { ...session, status: 'running' },
				),
			);

		case 'text_delta': {
			const session = state.sessions[input.ref];

			if (!session) {
				return withoutEffects(state);
			}

			const draft = session.draft + input.text;
			// A reply the developer's follow-up is cutting says nothing more: they are already past it.
			const { spokenInTurn, effects, held } = hasFollowUpWaiting(session)
				? { spokenInTurn: session.spokenInTurn, effects: [], held: null }
				: speakNewTag(session, draft, isHeardNow(state, input.ref, stamped.at));
			const drafted = updateSession(state, input.ref, (current) => ({
				...markSelfStarted(current),
				draft,
				spokenInTurn,
				...(spokenInTurn.length > current.spokenInTurn.length
					? { lineBeforeAsk: { at: stamped.at, text: cleanSessionLine(spokenInTurn.at(-1) ?? '') } }
					: {}),
			}));

			return {
				state: held
					? holdLine({ state: drafted, ref: input.ref, content: held, stamped })
					: drafted,
				effects,
			};
		}

		case 'assistant_text':
		case 'tool':
		case 'tool_result':
		case 'diff':
		case 'image':
		case 'doc': {
			const isText = input.type === 'assistant_text';
			const item = createStreamItem({ observation: input, id: stamped.id, at: stamped.at });
			const session = state.sessions[input.ref];

			if (!item || !session) {
				return withoutEffects(state);
			}

			// A doc linked again (every edit links it) or an image shown again is still the one line.
			if (isShownAlready(session.stream, input)) {
				return withoutEffects(state);
			}

			// A message that never streamed says its lines now; streamed ones were said already.
			const spoken =
				isText && !hasFollowUpWaiting(session)
					? speakNewTag(session, input.text, isHeardNow(state, input.ref, stamped.at))
					: null;
			// Text and a tool call end the streamed draft; results and diffs follow the tool line.
			const shouldClearDraft = isText || input.type === 'tool';

			const isNewLine = spoken !== null && spoken.spokenInTurn.length > session.spokenInTurn.length;
			// Anything the session did after its line, but opening the question or plan it announced,
			// means the line was not that ask.
			const isOtherTool = input.type === 'tool' && !ASK_TOOLS.has(input.name);
			const isActivity = input.type === 'assistant_text' || input.type === 'tool';
			const pushed = updateSession(state, input.ref, (current) =>
				pushStreamItem(
					{
						...(isActivity ? markSelfStarted(current) : current),
						...(shouldClearDraft ? { draft: '' } : {}),
						...(spoken ? { spokenInTurn: spoken.spokenInTurn } : {}),
						...(isNewLine
							? {
									lineBeforeAsk: {
										at: stamped.at,
										text: cleanSessionLine(spoken.spokenInTurn.at(-1) ?? ''),
									},
								}
							: {}),
						...(isOtherTool ? { lineBeforeAsk: null } : {}),
					},
					item,
				),
			);

			return {
				state: spoken?.held
					? holdLine({ state: pushed, ref: input.ref, content: spoken.held, stamped })
					: pushed,
				effects: spoken?.effects ?? [],
			};
		}

		case 'history_restored':
			// What came live before the history (another machine's reconnect notice, an ask) stays after
			// it; only history older than all of it is added, so nothing shows twice.
			return withoutEffects(
				updateSession(state, input.ref, (session) => {
					const firstAt = session.stream[0]?.at ?? Number.POSITIVE_INFINITY;
					const older = input.items.filter((item) => item.at < firstAt);

					return older.length === 0
						? session
						: { ...session, stream: [...older, ...session.stream].slice(-STREAM_ITEMS_KEPT) };
				}),
			);

		case 'turn_ended': {
			const session = state.sessions[input.ref];

			if (!session) {
				return withoutEffects(state);
			}

			// An allowance still waiting ends with the turn: the next one runs in auto mode again.
			const effects: Effect[] = restoreAutoEffects(session);

			// A reply cut off by the developer's follow-up is not narrated: they are already past it.
			const isCutOff = hasFollowUpWaiting(session);

			// The final message's own line, when the session wrote one: the narrator only fills a gap.
			const spoken = readSpokenTag(input.text);
			const isHeld =
				spoken !== null &&
				session.heldLine?.kind === 'line' &&
				session.heldLine.text === spoken.text;

			// A turn nobody sent (a background agent reporting back) speaks only through its own tag: its
			// untagged "still waiting" lines, narrated one after another, were noise.
			const isSelfStarted = session.currentSendId === null && !session.reportOwed;
			const isSilent = isSelfStarted && spoken === null;

			// A promised report is given even for a turn that wrote nothing.
			if ((input.text.trim() || session.reportOwed) && !isCutOff && !isSilent) {
				effects.push({
					type: 'narrate',
					ref: input.ref,
					text: input.text,
					asked: findLastUserText(session),
					isOwed: session.reportOwed,
					spoken,
					// Held while the developer looked elsewhere: streamed, but never said.
					isHeld,
					isSpokenAlready: spoken !== null && session.spokenInTurn.includes(spoken.text) && !isHeld,
					hasBackgroundAgents: hasBackgroundWork(session),
					...(input.head !== undefined ? { head: input.head } : {}),
				});
			}

			// Cleared here, before the queue head is sent: that next turn owes its own report.
			const ended = updateSession(state, input.ref, (current) => ({
				...current,
				status: 'idle',
				draft: '',
				allowOnce: null,
				voiceTurnAt: null,
				reportOwed: false,
				spokenInTurn: [],
				lineBeforeAsk: null,
				askedByLine: null,
				currentSendId: null,
				costUsd: current.costUsd + input.costUsd,
				lastTurnId: input.turnId ?? current.lastTurnId,
				// A foreground sub-agent blocks the turn's tool call, so the turn's end is its end too.
				subagents: current.subagents.filter((subagent) => subagent.isBackground),
				compactingSince: null,
			}));
			// The work a held switch asked about is over: what it wanted goes next, ahead of the queue.
			const switched = moveHeldRedirectAhead(ended, input.ref, stamped);
			const dispatched = dispatchQueueHead(switched, input.ref, stamped);

			return { state: dispatched.state, effects: [...effects, ...dispatched.effects] };
		}

		case 'worker_exited': {
			// A held switch keeps its words: queued for the next start, not dropped with the asks.
			const heldRedirect = findRedirectAsk(state, input.ref);
			const settled = { ...state, asks: state.asks.filter((ask) => ask.ref !== input.ref) };
			const owed = state.sessions[input.ref]?.reportOwed;
			const stopped = updateSession(settled, input.ref, (session) => ({
				...session,
				status: 'stopped',
				draft: '',
				error: input.error,
				voiceTurnAt: null,
				queue: input.error ? session.queue : [],
				allowOnce: null,
				subagents: [],
				compactingSince: null,
				reportOwed: false,
				currentSendId: null,
				heldLine: null,
				lineBeforeAsk: null,
				askedByLine: null,
			}));
			const kept = heldRedirect
				? queueHeldRedirect({ state: stopped, ask: heldRedirect, at: stamped.at, isFirst: false })
				: stopped;

			// A report was owed: a crash before it is the report.
			return input.error && owed
				? { state: kept, effects: [describeUnfinished(input.ref)] }
				: withoutEffects(kept);
		}

		case 'notes':
			return withoutEffects({
				...state,
				notes: { ...state.notes, [input.workspace]: input.lines },
			});

		case 'limits':
			return withoutEffects({ ...state, limits: input.limits });

		case 'narration':
			return withoutEffects(
				updateSession(state, input.ref, (session) => ({
					...session,
					needsUser: input.needsUser ? { text: input.text, at: stamped.at } : null,
					topic: session.isTopicPinned || !input.topic ? session.topic : input.topic,
				})),
			);

		case 'line_held': {
			// A line that asked the question now open is held as that question: switching there reads the
			// question itself, not "— still working".
			const openAsk = state.asks.find(
				(ask) => ask.ref === input.ref && (ask.kind === 'question' || ask.kind === 'plan'),
			);

			// Its alert told that question (the line was never heard): nothing more to keep.
			if (openAsk && state.sessions[input.ref]?.askedByLine !== openAsk.id) {
				return withoutEffects(state);
			}

			return withoutEffects(
				holdLine({
					state,
					ref: input.ref,
					content: openAsk
						? { kind: 'ask', askId: openAsk.id }
						: { kind: 'line', text: input.text, isAsking: input.isAsking },
					stamped,
				}),
			);
		}

		case 'held_line_announced':
			return withoutEffects(
				state.sessions[input.ref]?.heldLine?.id === input.id
					? updateSession(state, input.ref, (session) => ({
							...session,
							heldLine: session.heldLine ? { ...session.heldLine, isAnnounced: true } : null,
						}))
					: state,
			);

		case 'held_line_heard':
			return withoutEffects(
				state.sessions[input.ref]?.heldLine?.id === input.id
					? clearHeldLine(state, input.ref)
					: state,
			);

		case 'spoken_ended':
			return withoutEffects({
				...state,
				spoken: state.spoken.map((line) =>
					line.id === input.lineId
						? {
								...line,
								endedAt: stamped.at,
								...(input.isCut ? { isCut: true as const } : {}),
								...(input.isUnplayed ? { isUnplayed: true as const } : {}),
							}
						: line,
				),
			});

		case 'topic_written':
			return withoutEffects(
				updateSession(state, input.ref, (session) =>
					session.isTopicPinned ? session : { ...session, topic: input.topic },
				),
			);

		case 'spoken':
			return withoutEffects({
				...state,
				spoken: [
					...state.spoken,
					{
						id: stamped.id,
						text: input.text,
						source: input.source,
						at: stamped.at,
						...(input.ref ? { ref: input.ref } : {}),
						...(input.isAsking ? { isAsking: true as const } : {}),
						...(input.isAnswer ? { isAnswer: true as const } : {}),
					},
				].slice(-SPOKEN_LINES_KEPT),
			});

		case 'voice_logged': {
			if (input.screen !== GRID && !state.sessions[input.screen]) {
				return withoutEffects(state);
			}

			const entry = capEntry(input.entry);
			const screenLog = [...(state.voiceLog[input.screen] ?? []), entry].slice(
				-VOICE_LOG_ENTRIES_KEPT,
			);

			return withoutEffects({
				...state,
				voiceLog: { ...state.voiceLog, [input.screen]: screenLog },
			});
		}

		case 'conversation_reset': {
			// The next message is the new conversation's first, so it carries Voice OS's context again.
			const reset = updateSession(state, input.ref, (session) => ({
				...session,
				isFresh: true,
				subagents: [],
				compactingSince: null,
			}));

			return withoutEffects(
				pushNotice({
					state: reset,
					ref: input.ref,
					text: 'Context cleared.',
					stamped,
					suffix: 'reset',
				}),
			);
		}

		case 'compacting':
			return withoutEffects(
				updateSession(state, input.ref, (session) => ({
					...session,
					// A second "compacting" keeps the time it began.
					compactingSince: input.isCompacting ? (session.compactingSince ?? stamped.at) : null,
				})),
			);

		case 'session_notice':
			return withoutEffects(
				pushNotice({ state, ref: input.ref, text: input.text, stamped, suffix: 'notice' }),
			);

		case 'transcript':
			return withoutEffects({ ...state, transcript: input.transcript });

		case 'setup':
			return withoutEffects({ ...state, setup: { missing: input.missing } });

		// followExchange (exchange.ts) owns these.
		case 'exchange_expired':
		case 'clear_exchange':
		case 'offer_switch':
		case 'switch_offer_closed':
			return withoutEffects(state);
	}

	// A browser tab left open across an upgrade runs older code than the server: it must reload, not guess.
	const unknownInput: never = input;
	throw new Error(`unknown input: ${(unknownInput as { type: string }).type}`);
};

export const reduce = (state: State, stamped: Stamped): ReducerResult => {
	const before = { ...state, seq: stamped.seq };

	return followExchange(before, reduceInput(before, stamped), stamped);
};
