// What a remote keeps about its own sessions so any main that attaches can be told where things
// stand: no reducer, just the few facts the snapshot carries.

import type { Observation, PendingAsk } from '../shared/protocol.js';
import type { HandsEffect } from './mapping.js';
import type {
	AsideInFlight,
	LastTurn,
	SequencedEffect,
	Snapshot,
	SessionSnapshot,
} from './protocol.js';
import type { ContextUsage, SessionCommand, WorktreeInfo } from '../shared/protocol.js';

export type HostSessionStatus = 'stopped' | 'starting' | 'idle' | 'running';

export interface HostSession {
	status: HostSessionStatus;
	lastTurn: LastTurn | null;
	commands?: SessionCommand[];
	context?: ContextUsage;
}

export interface HostState {
	sessions: Record<string, HostSession>;
	asks: PendingAsk[];
	asides: AsideInFlight[];
}

export const createHostState = (): HostState => ({ sessions: {}, asks: [], asides: [] });

const setStatus = (state: HostState, ref: string, status: HostSessionStatus): HostState => ({
	...state,
	sessions: {
		...state.sessions,
		[ref]: { ...state.sessions[ref], lastTurn: state.sessions[ref]?.lastTurn ?? null, status },
	},
});

export const trackEffect = (state: HostState, effect: HandsEffect): HostState => {
	switch (effect.type) {
		case 'worker_start':
			return state.sessions[effect.ref]?.status === 'idle' ||
				state.sessions[effect.ref]?.status === 'running'
				? state
				: setStatus(state, effect.ref, 'starting');
		case 'worker_stop':
			return {
				...setStatus(state, effect.ref, 'stopped'),
				asks: state.asks.filter((ask) => ask.ref !== effect.ref),
				asides: state.asides.filter((aside) => aside.ref !== effect.ref),
			};
		// Working from the moment it takes words: a snapshot built right after (a reconnect applying
		// what the main resent) must not call it idle before its turn_started is reported.
		case 'worker_send':
			return state.sessions[effect.ref]?.status === 'idle'
				? setStatus(state, effect.ref, 'running')
				: state;
		case 'side_answer':
			return { ...state, asides: [...state.asides, { ref: effect.ref, itemId: effect.itemId }] };
		default:
			return state;
	}
};

export const trackObservation = (state: HostState, observation: Observation): HostState => {
	switch (observation.type) {
		case 'session_started':
			return setStatus(state, observation.ref, 'idle');
		case 'turn_started':
			return setStatus(state, observation.ref, 'running');
		case 'turn_ended': {
			const ended = setStatus(state, observation.ref, 'idle');

			return observation.turnId
				? {
						...ended,
						sessions: {
							...ended.sessions,
							[observation.ref]: {
								...ended.sessions[observation.ref],
								status: 'idle',
								lastTurn: {
									id: observation.turnId,
									text: observation.text,
									costUsd: observation.costUsd,
									head: observation.head ?? null,
								},
							},
						},
					}
				: ended;
		}
		case 'commands_listed':
			return {
				...state,
				sessions: {
					...state.sessions,
					[observation.ref]: {
						...state.sessions[observation.ref],
						status: state.sessions[observation.ref]?.status ?? 'idle',
						lastTurn: state.sessions[observation.ref]?.lastTurn ?? null,
						commands: observation.commands,
					},
				},
			};
		// A cleared conversation's old reading no longer holds.
		case 'conversation_reset': {
			const { context: _cleared, ...session } = state.sessions[observation.ref] ?? {
				status: 'idle' as const,
				lastTurn: null,
			};

			return { ...state, sessions: { ...state.sessions, [observation.ref]: session } };
		}
		case 'context_usage': {
			const { used, max, compactAt } = observation;

			return {
				...state,
				sessions: {
					...state.sessions,
					[observation.ref]: {
						...state.sessions[observation.ref],
						status: state.sessions[observation.ref]?.status ?? 'idle',
						lastTurn: state.sessions[observation.ref]?.lastTurn ?? null,
						context: { used, max, ...(compactAt === undefined ? {} : { compactAt }) },
					},
				},
			};
		}
		case 'worker_exited':
			return {
				...setStatus(state, observation.ref, 'stopped'),
				asks: state.asks.filter((ask) => ask.ref !== observation.ref),
			};
		case 'ask_opened':
			return {
				...state,
				asks: [...state.asks.filter((ask) => ask.id !== observation.ask.id), observation.ask],
			};
		case 'ask_closed':
			return { ...state, asks: state.asks.filter((ask) => ask.id !== observation.askId) };
		case 'aside_settled':
			return {
				...state,
				asides: state.asides.filter(
					(aside) => !(aside.ref === observation.ref && aside.itemId === observation.itemId),
				),
			};
		default:
			return state;
	}
};

export const isBusy = (state: HostState): boolean =>
	Object.values(state.sessions).some((session) => session.status === 'running');

export const buildSnapshot = (state: HostState, worktrees: WorktreeInfo[]): Snapshot => ({
	worktrees,
	sessions: Object.entries(state.sessions)
		.filter(([, session]) => session.status !== 'stopped')
		.map(
			([ref, session]): SessionSnapshot => ({
				ref,
				status: session.status as SessionSnapshot['status'],
				lastTurn: session.lastTurn,
				...(session.commands ? { commands: session.commands } : {}),
				...(session.context ? { context: session.context } : {}),
			}),
		),
	asks: state.asks,
	asides: state.asides,
});

// Effects already applied are skipped: a main resends what it never saw acknowledged. A new main
// process (another runId) counts from 1 again.
export interface Inbox {
	mainId: string;
	runId: string;
	lastSeq: number;
}

export const openInbox = (inbox: Inbox | null, mainId: string, runId: string): Inbox =>
	inbox && inbox.mainId === mainId && inbox.runId === runId ? inbox : { mainId, runId, lastSeq: 0 };

export interface AcceptedEffects {
	inbox: Inbox;
	effects: HandsEffect[];
}

export const acceptEffects = (inbox: Inbox, sequenced: SequencedEffect[]): AcceptedEffects => {
	const effects: HandsEffect[] = [];
	let { lastSeq } = inbox;

	for (const { seq, effect } of [...sequenced].sort((left, right) => left.seq - right.seq)) {
		if (seq > lastSeq) {
			effects.push(effect);
			lastSeq = seq;
		}
	}

	return { inbox: { ...inbox, lastSeq }, effects };
};
