// The active set: which sessions run and are driven by voice (shared/active.ts reads it).
import { isActive } from '../shared/active.js';
import { isKnownMachineRef, isReachable, readMachineTitle } from '../shared/machines.js';
import { SETUP_REF, machineOf } from '../shared/machine-ref.js';
import type { Input, State, View } from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { settleAsksForSession } from './asks.js';
import {
	readScreenRef,
	sayAck,
	sayRef,
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

// Starts an active session that is present, stopped and reachable; anything else waits for that.
const startIfStopped = (state: State, ref: string): ReducerResult =>
	isActive(state, ref) && isStartable(state, ref) ? startWorker(state, ref) : withoutEffects(state);

// Stops a session and lets go of everything Voice OS still holds for it: nothing it had waiting is
// said, asked or sent later. Its conversation stays in sessions.json for its next start.
export const stopWorker = (state: State, ref: string): ReducerResult => {
	const session = state.sessions[ref];

	if (!session) {
		return withoutEffects(state);
	}

	const settled = settleAsksForSession(state, ref, 'The session was stopped.');
	const isOther = (other: string): boolean => other !== ref;
	const cleared: State = {
		...settled.state,
		meanwhile: settled.state.meanwhile.filter((item) => isOther(item.ref)),
		denials: settled.state.denials.filter((denial) => isOther(denial.ref)),
		devOffer: settled.state.devOffer?.ref === ref ? null : settled.state.devOffer,
		switchOffer: settled.state.switchOffer?.ref === ref ? null : settled.state.switchOffer,
		targetAsk:
			settled.state.targetAsk?.ref === ref || settled.state.targetAsk?.screen === ref
				? null
				: settled.state.targetAsk,
		lastSpokenSend: settled.state.lastSpokenSend?.ref === ref ? null : settled.state.lastSpokenSend,
		focus: settled.state.focus === ref && readScreenRef(state) !== ref ? null : settled.state.focus,
	};
	const stopped = updateSession(cleared, ref, (current) => ({
		...current,
		status: 'stopped',
		queue: [],
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

const activate = (
	state: State,
	input: Extract<ActiveInput, { type: 'activate' }>,
	at: number,
): ReducerResult => {
	const { ref } = input;

	if (!state.sessions[ref] || !isKnownMachineRef(state, ref)) {
		return withoutEffects(state);
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
			sayAck(`Activated ${sayRef(state, ref)}. Switch there?`, { isAsking: true, ref }),
		],
	};
};

const deactivate = (state: State, ref: string): ReducerResult => {
	// The main's setup session is always active; a ref that is not active has nothing to undo.
	if (!state.active.includes(ref)) {
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
export const startActive = (state: State, refs: string[]): ReducerResult =>
	refs.reduce<ReducerResult>((result, ref) => {
		const next = startIfStopped(result.state, ref);

		return { state: next.state, effects: [...result.effects, ...next.effects] };
	}, withoutEffects(state));

// A machine's link came up: its active sessions run there, its inactive ones do not. Also how a
// deactivate made while it was out of reach reaches it.
export const matchMachine = (state: State, machine: string): ReducerResult => {
	const refs = state.order.filter((ref) => machineOf(ref) === machine);
	let result = startActive(
		state,
		refs.filter((ref) => isActive(state, ref)),
	);
	const stopped: string[] = [];

	for (const ref of refs) {
		if (isActive(result.state, ref) || result.state.sessions[ref]?.status === 'stopped') {
			continue;
		}

		const next = stopWorker(result.state, ref);

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
			// The saved order first; one activated before the file was read follows it. This Mac's setup
			// is always active and never stored.
			const active = [...new Set([...input.refs, ...state.active])].filter(
				(ref) => ref !== SETUP_REF && isKnownMachineRef(state, ref),
			);
			const loaded = { ...state, active };

			return startActive(loaded, listStartable(loaded));
		}
	}
};

// This Mac's active sessions, the setup session included: a remote's start when its link is up.
const listStartable = (state: State): string[] =>
	state.order.filter((ref) => machineOf(ref) === null && isActive(state, ref));

// Worktrees that just appeared: the active ones among them start (a refresh that failed at boot and
// succeeded later still starts them).
export const startAppeared = (before: State, after: State): ReducerResult =>
	startActive(
		after,
		after.order.filter(
			(ref) => !before.sessions[ref] && machineOf(ref) === null && isActive(after, ref),
		),
	);
