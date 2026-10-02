// The active set: which sessions run and are driven by voice (shared/active.ts reads it).
import { canRun, isActive } from '../shared/active.js';
import { isKnownMachineRef, isReachable, readMachineTitle } from '../shared/machines.js';
import { isSetupRef, machineOf } from '../shared/machine-ref.js';
import type { Input, State, View } from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { settleAsksForSession } from './asks.js';
import {
	readScreenRef,
	sayAck,
	sayRef,
	releaseRefs,
	startWorker,
	updateSession,
	withoutEffects,
} from './helpers.js';

const ACTIVE_INPUTS = ['activate', 'deactivate', 'active_loaded'] as const;

type ActiveInput = Extract<Input, { type: (typeof ACTIVE_INPUTS)[number] }>;

const ACTIVE_INPUT_SET = new Set<string>(ACTIVE_INPUTS);

export const isActiveInput = (input: Input): input is ActiveInput =>
	ACTIVE_INPUT_SET.has(input.type);

// An active session opens inside Active from wherever it is opened, so its tabs are the active
// sessions and Esc goes back there; any other session opens in its machine.
export const toShownView = (state: State, view: View): View => {
	if (view.kind !== 'session') {
		return view;
	}

	return isActive(state, view.ref)
		? { kind: 'session', ref: view.ref, from: 'active' }
		: { kind: 'session', ref: view.ref };
};

const isStartable = (state: State, ref: string): boolean =>
	state.sessions[ref]?.status === 'stopped' && isReachable(state, ref);

// Starts a session that may run (active, or a setup session) and is present, stopped and
// reachable; anything else waits for that.
const startIfStopped = (state: State, ref: string): ReducerResult =>
	canRun(state, ref) && isStartable(state, ref) ? startWorker(state, ref) : withoutEffects(state);

// Stops a session and lets go of everything Voice OS still holds for it: nothing it had waiting is
// said, asked or sent later. Its conversation stays in sessions.json for its next start. keepQueue:
// words waiting for it stay for its next start (a stop it did not ask for, on reconnect).
export const stopWorker = (
	state: State,
	ref: string,
	{ keepQueue = false } = {},
): ReducerResult => {
	const session = state.sessions[ref];

	if (!session) {
		return withoutEffects(state);
	}

	const settled = settleAsksForSession(state, ref, 'The session was stopped.');
	const released = releaseRefs(settled.state, (other) => other === ref);
	const cleared: State = {
		...released,
		focus: released.focus === ref && readScreenRef(state) !== ref ? null : released.focus,
	};
	const stopped = updateSession(cleared, ref, (current) => ({
		...current,
		status: 'stopped',
		queue: keepQueue ? current.queue : [],
		draft: '',
		needsUser: null,
		voiceTurnAt: null,
		compactingSince: null,
		allowOnce: null,
		reportOwed: false,
		currentSendId: null,
		heldLine: null,
		lineBeforeAsk: null,
		askedByLine: null,
	}));
	const effects: Effect[] = [
		...settled.effects,
		// Whatever it still had queued to say is dropped with it.
		{ type: 'drop_speech', ref, before: Number.MAX_SAFE_INTEGER },
		...(session.status === 'stopped' ? [] : [{ type: 'worker_stop' as const, ref }]),
	];

	return { state: stopped, effects };
};

const describeOutOfReach = (state: State, ref: string): Effect | null =>
	isReachable(state, ref)
		? null
		: sayAck(
				`${readMachineTitle(state, machineOf(ref) ?? '')} is out of reach; ${sayRef(state, ref)} starts when it's back.`,
			);

// How long an activation of a worktree Voice OS has not listed yet waits for a list that has it:
// crew made it moments ago (Set up), so the next read has it; a remote's list comes on its own poll.
export const PENDING_ACTIVATION_MS = 60_000;

// A worktree crew has but Voice OS has not listed yet: held, and crew is read again now.
const holdActivation = (
	state: State,
	input: Extract<ActiveInput, { type: 'activate' }>,
	at: number,
): ReducerResult => ({
	state: {
		...state,
		pendingActivations: [
			...state.pendingActivations.filter(
				(pending) => pending.ref !== input.ref && at - pending.at < PENDING_ACTIVATION_MS,
			),
			{ ref: input.ref, at, isOpening: Boolean(input.open) },
		],
	},
	effects: [{ type: 'refresh_worktrees' }],
});

const activate = (
	state: State,
	input: Extract<ActiveInput, { type: 'activate' }>,
	at: number,
): ReducerResult => {
	const { ref } = input;

	// A setup session belongs to Set up: it runs for its chat and is never part of voice.
	if (!isKnownMachineRef(state, ref) || isSetupRef(ref)) {
		return withoutEffects(state);
	}

	if (!state.sessions[ref]) {
		return holdActivation(state, input, at);
	}

	const added: State = isActive(state, ref)
		? state
		: {
				...state,
				active: [...state.active, ref],
				// The open session now belongs to Active: its tabs and Esc follow.
				view:
					state.view.kind === 'session' && state.view.ref === ref
						? { kind: 'session', ref, from: 'active' }
						: state.view,
			};
	const started = startIfStopped(added, ref);

	if (!input.announce) {
		return started;
	}

	const outOfReach = describeOutOfReach(added, ref);

	if (outOfReach) {
		return { state: started.state, effects: [...started.effects, outOfReach] };
	}

	// On screen already: the developer sees it start, and a question would ask nothing.
	if (readScreenRef(state) === ref) {
		return started;
	}

	return {
		state: { ...started.state, switchOffer: { ref, at } },
		effects: [
			...started.effects,
			sayAck(
				(state.sessions[ref]?.queue.length ?? 0) > 0
					? `Activated ${sayRef(state, ref)}; your words go once it's up. Switch there?`
					: `Activated ${sayRef(state, ref)}. Switch there?`,
				{ isAsking: true, ref },
			),
		],
	};
};

const deactivate = (state: State, ref: string): ReducerResult => {
	// A ref that is not active (a setup session never is) has nothing to undo.
	if (!isActive(state, ref)) {
		return withoutEffects(state);
	}

	const removed: State = {
		...state,
		active: state.active.filter((kept) => kept !== ref),
		// Still on screen, but no longer in Active: Esc goes to its machine.
		view:
			state.view.kind === 'session' && state.view.ref === ref
				? { kind: 'session', ref }
				: state.view,
	};

	return stopWorker(removed, ref);
};

// Every active session that is present, stopped and reachable is started, once.
const startActive = (state: State, refs: string[]): ReducerResult =>
	refs.reduce<ReducerResult>((result, ref) => {
		const next = startIfStopped(result.state, ref);

		return { state: next.state, effects: [...result.effects, ...next.effects] };
	}, withoutEffects(state));

// A machine's link came up: its active sessions and its setup session run there, its inactive ones
// do not. Also how a deactivate made while it was out of reach reaches it.
export const matchMachine = (state: State, machine: string): ReducerResult => {
	const refs = state.order.filter((ref) => machineOf(ref) === machine);
	let result = startActive(
		state,
		refs.filter((ref) => canRun(state, ref)),
	);
	const stopped: string[] = [];

	for (const ref of refs) {
		if (canRun(result.state, ref) || result.state.sessions[ref]?.status === 'stopped') {
			continue;
		}

		const next = stopWorker(result.state, ref, { keepQueue: true });

		stopped.push(ref);
		result = { state: next.state, effects: [...result.effects, ...next.effects] };
	}

	if (stopped.length === 0) {
		return result;
	}

	const count = stopped.length === 1 ? 'one session' : `${stopped.length} sessions`;
	const verb = stopped.length === 1 ? "isn't" : "aren't";

	return {
		state: result.state,
		effects: [
			...result.effects,
			{
				type: 'speak',
				text: `Stopped ${count} on ${readMachineTitle(state, machine)} that ${verb} active.`,
				source: 'kernel',
			},
		],
	};
};

export const reduceActive = (state: State, input: ActiveInput, at: number): ReducerResult => {
	switch (input.type) {
		case 'activate':
			return activate(state, input, at);

		case 'deactivate':
			return deactivate(state, input.ref);

		case 'active_loaded': {
			// The saved order first; one activated before the file was read follows it. A setup session
			// stored by an earlier release is dropped: it runs for Set up, never as active.
			const active = [...new Set([...input.refs, ...state.active])].filter(
				(ref) => !isSetupRef(ref) && isKnownMachineRef(state, ref),
			);
			const loaded = { ...state, active };

			return startActive(loaded, listStartable(loaded));
		}
	}
};

// This Mac's active sessions and its setup session: a remote's start when its link is up.
const listStartable = (state: State): string[] =>
	state.order.filter((ref) => machineOf(ref) === null && canRun(state, ref));

// Worktrees that just appeared: the active ones among them start (a refresh that failed at boot and
// succeeded later still starts them).
export const startAppeared = (before: State, after: State): ReducerResult =>
	startActive(
		after,
		after.order.filter(
			(ref) => !before.sessions[ref] && machineOf(ref) === null && canRun(after, ref),
		),
	);
