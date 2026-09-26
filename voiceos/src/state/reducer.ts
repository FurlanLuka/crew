import {
	GRID,
	VOICE_LOG_ENTRIES_KEPT,
	type Session,
	type Stamped,
	type State,
	type VoiceEntry,
	type WorktreeInfo,
} from '../shared/protocol.js';
import { isAskInput, reduceAsk, settleAsksForSession } from './asks.js';
import { isDevInput, reduceDev } from './dev.js';
import {
	createStreamItem,
	dispatchQueueHead,
	pushStreamItem,
	startWorker,
	STREAM_ITEMS_KEPT,
	truncateText,
	updateSession,
	withoutEffects,
} from './helpers.js';
import { hasFollowUpWaiting, reduceSend } from './send.js';

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
	| { type: 'resolve_ask'; askId: string; result: AskResult }
	| { type: 'narrate'; ref: string; text: string; asked: string | null }
	// reply: the answer to what the developer just said (no chime before it).
	| {
			type: 'speak';
			text: string;
			source: 'kernel' | 'narrator' | 'alert';
			isReply?: boolean;
			ref?: string;
			isAsking?: boolean;
	  }
	| { type: 'dev'; ref: string; action: 'start' | 'stop' | 'restart' }
	| { type: 'fix_dev'; ref: string; servers: string[] };

export interface ReducerResult {
	state: State;
	effects: Effect[];
}

export const createInitialState = (): State => ({
	seq: 0,
	sessions: {},
	order: [],
	view: { kind: 'grid' },
	focus: null,
	asks: [],
	denials: [],
	transcript: null,
	spoken: [],
	limits: { fiveHour: null, sevenDay: null, resetsAt: null },
	setup: { missing: [] },
	devServers: {},
	devStarting: [],
	devOffer: null,
	voiceLog: {},
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
	modeOverride: null,
	costUsd: 0,
	error: null,
	voiceTurnAt: null,
	isFresh: false,
	requests: [],
});

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

	const order = Object.values(sessions)
		.sort(
			(left, right) =>
				Number(right.isPinned) - Number(left.isPinned) || left.ref.localeCompare(right.ref),
		)
		.map((session) => session.ref);
	const view =
		state.view.kind === 'session' && !sessions[state.view.ref]
			? { kind: 'grid' as const }
			: state.view;
	const focus = state.focus && sessions[state.focus] ? state.focus : null;
	const voiceLog = Object.fromEntries(
		Object.entries(state.voiceLog).filter(([screen]) => screen === GRID || sessions[screen]),
	);

	return { ...state, sessions, order, view, focus, voiceLog };
};

const reduceInput = (state: State, stamped: Stamped): ReducerResult => {
	const { input } = stamped;

	if (isAskInput(input)) {
		return reduceAsk(state, input, stamped);
	}

	if (isDevInput(input)) {
		return reduceDev(state, input, stamped);
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

		case 'switch_view': {
			const { view } = input;

			if (view.kind === 'session' && !state.sessions[view.ref]) {
				return withoutEffects(state);
			}

			return withoutEffects({
				...state,
				view,
				focus: view.kind === 'session' ? view.ref : state.focus,
			});
		}

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
				})),
				effects: [...settled.effects, { type: 'worker_interrupt', ref: input.ref }],
			};
		}

		case 'dismiss_needs_user':
			return withoutEffects(
				updateSession(state, input.ref, (session) => ({ ...session, needsUser: null })),
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

			const ready = updateSession(state, input.ref, (session) => ({
				...session,
				status: 'idle',
				error: null,
			}));

			return dispatchQueueHead(ready, input.ref, stamped);
		}

		case 'turn_started':
			return withoutEffects(
				updateSession(state, input.ref, (session) =>
					session.status === 'blocked' ? session : { ...session, status: 'running' },
				),
			);

		case 'text_delta':
			return withoutEffects(
				updateSession(state, input.ref, (session) => ({
					...session,
					draft: session.draft + input.text,
				})),
			);

		case 'assistant_text':
		case 'tool':
		case 'tool_result':
		case 'diff': {
			const item = createStreamItem({ observation: input, id: stamped.id, at: stamped.at });

			if (!item) {
				return withoutEffects(state);
			}

			// Text and a tool call end the streamed draft; results and diffs follow the tool line.
			const shouldClearDraft = input.type === 'assistant_text' || input.type === 'tool';

			return withoutEffects(
				updateSession(state, input.ref, (session) =>
					pushStreamItem(shouldClearDraft ? { ...session, draft: '' } : session, item),
				),
			);
		}

		case 'history_restored':
			return withoutEffects(
				updateSession(state, input.ref, (session) =>
					session.stream.length > 0
						? session
						: { ...session, stream: input.items.slice(-STREAM_ITEMS_KEPT) },
				),
			);

		case 'turn_ended': {
			const session = state.sessions[input.ref];

			if (!session) {
				return withoutEffects(state);
			}

			const effects: Effect[] = [];

			if (session.modeOverride === 'default-once') {
				effects.push({ type: 'worker_set_mode', ref: input.ref, mode: 'auto' });
			}

			// A reply cut off by the developer's follow-up is not narrated: they are already past it.
			const isCutOff = hasFollowUpWaiting(session);

			if (input.text.trim() && !isCutOff) {
				effects.push({
					type: 'narrate',
					ref: input.ref,
					text: input.text,
					asked: findLastUserText(session),
				});
			}

			const ended = updateSession(state, input.ref, (current) => ({
				...current,
				status: 'idle',
				draft: '',
				modeOverride: null,
				voiceTurnAt: null,
				costUsd: current.costUsd + input.costUsd,
			}));
			const dispatched = dispatchQueueHead(ended, input.ref, stamped);

			return { state: dispatched.state, effects: [...effects, ...dispatched.effects] };
		}

		case 'worker_exited': {
			const settled = { ...state, asks: state.asks.filter((ask) => ask.ref !== input.ref) };

			return withoutEffects(
				updateSession(settled, input.ref, (session) => ({
					...session,
					status: 'stopped',
					draft: '',
					error: input.error,
					voiceTurnAt: null,
					queue: input.error ? session.queue : [],
				})),
			);
		}

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

		case 'transcript':
			return withoutEffects({ ...state, transcript: input.transcript });

		case 'setup':
			return withoutEffects({ ...state, setup: { missing: input.missing } });
	}
};

export const reduce = (state: State, stamped: Stamped): ReducerResult =>
	reduceInput({ ...state, seq: stamped.seq }, stamped);
