import { pruneViewHistory } from './view-history.js';
import { machineOf } from '../shared/machine-ref.js';
import { dropMachineAttachments } from './attachments.js';
import {
	currentMachine,
	describeMachineWaiting,
	HOME_VIEW,
	hasMachines,
	isReachable,
	isValidHost,
	machineIdFor,
	readMachineTitle,
	toMachineConfigs,
} from '../shared/machines.js';
import type {
	Input,
	Machine,
	MachineConfig,
	QueuedMessage,
	Session,
	Stamped,
	State,
	View,
} from '../shared/protocol.js';
import type { Effect, MachineChange, ReducerResult } from './reducer.js';
import {
	dispatchQueueHead,
	releaseRefs,
	startWorker,
	updateSession,
	withoutEffects,
} from './helpers.js';
import { matchMachine } from './active.js';
import { canRun, isActive } from '../shared/active.js';

const MACHINE_INPUTS = [
	'machines',
	'machine_status',
	'machine_resynced',
	'add_machine',
	'rename_machine',
	'remove_machine',
] as const;

type MachineInput = Extract<Input, { type: (typeof MACHINE_INPUTS)[number] }>;

const MACHINE_INPUT_SET = new Set<string>(MACHINE_INPUTS);

export const isMachineInput = (input: Input): input is MachineInput =>
	MACHINE_INPUT_SET.has(input.type);

export type ReduceInner = (state: State, stamped: Stamped) => ReducerResult;

const say = (text: string, isAck = false): Effect => ({
	type: 'speak',
	text,
	source: 'kernel',
	isReply: true,
	priority: 'high',
	...(isAck ? { isAck } : {}),
});

// A removed machine's sessions leave this Voice OS; they keep running there.
const dropMachineSessions = (state: State, removed: string[]): State => {
	if (removed.length === 0) {
		return state;
	}

	const isKept = (ref: string): boolean => !removed.includes(machineOf(ref) ?? '');
	const sessions = Object.fromEntries(
		Object.entries(state.sessions).filter(([ref]) => isKept(ref)),
	);
	const isViewGone =
		(state.view.kind === 'session' && !isKept(state.view.ref)) ||
		(state.view.kind === 'activate' &&
			state.view.machine !== undefined &&
			removed.includes(state.view.machine));
	const view: View = isViewGone ? HOME_VIEW : state.view;

	return {
		...releaseRefs(state, (ref) => !isKept(ref)),
		sessions,
		order: state.order.filter(isKept),
		active: state.active.filter(isKept),
		names: Object.fromEntries(Object.entries(state.names).filter(([ref]) => isKept(ref))),
		asks: state.asks.filter((ask) => isKept(ask.ref)),
		devServers: Object.fromEntries(Object.entries(state.devServers).filter(([ref]) => isKept(ref))),
		devStarting: state.devStarting.filter(isKept),
		focus: state.focus && isKept(state.focus) ? state.focus : null,
		viewHistory: pruneViewHistory(
			state.viewHistory,
			isKept,
			(machine) => !removed.includes(machine),
		),
		voiceLog: Object.fromEntries(
			Object.entries(state.voiceLog).filter(([screen]) => isKept(screen)),
		),
		view,
	};
};

const applyConfigs = (state: State, configs: MachineConfig[], at: number): State => {
	const machines: Record<string, Machine> = {};

	for (const config of configs) {
		const existing = state.machines[config.id];

		machines[config.id] =
			existing && existing.host === config.host
				? { ...existing, name: config.name }
				: { ...config, status: 'connecting', detail: null, since: at };
	}

	const removed = Object.keys(state.machines).filter((id) => !machines[id]);

	return dropMachineSessions({ ...state, machines }, removed);
};

// The state follows at once; machines.json is written by crew (the effect), and its reload agrees.
const withChange = (
	state: State,
	configs: MachineConfig[],
	at: number,
	change: MachineChange,
): ReducerResult => ({
	state: applyConfigs(state, configs, at),
	effects: [{ type: 'machines_changed', change }],
});

// A snapshot's inputs are applied as one step: what they would say was said there, or is told by
// the recap; what they would send waits for the machine to be connected.
const quietEffects = (effects: Effect[]): Effect[] =>
	effects.flatMap((effect): Effect[] => {
		switch (effect.type) {
			case 'narrate':
				return [{ ...effect, isQuiet: true }];
			case 'speak':
			case 'drop_speech':
			case 'narrate_aside':
				return [];
			default:
				return [effect];
		}
	});

interface ResyncParams {
	state: State;
	id: string;
	inputs: Input[];
	stamped: Stamped;
	reduceInner: ReduceInner;
}

const resync = ({ state, id, inputs, stamped, reduceInner }: ResyncParams): ReducerResult => {
	const machine = state.machines[id];

	if (!machine) {
		return withoutEffects(state);
	}

	let next: State = {
		...state,
		machines: { ...state.machines, [id]: { ...machine, status: 'syncing' } },
	};
	const effects: Effect[] = [];

	inputs.forEach((inner, index) => {
		const result = reduceInner(next, { ...stamped, id: `${stamped.id}:${index}`, input: inner });

		next = result.state;
		effects.push(...quietEffects(result.effects));
	});

	next = {
		...next,
		machines: {
			...next.machines,
			[id]: { ...machine, status: 'connected', detail: null, since: stamped.at },
		},
	};

	// What waited while it was out of reach goes now: one message per idle session, and a stopped
	// session with words waiting is started for them (its start sends the first).
	for (const ref of next.order) {
		const session = next.sessions[ref];

		// An inactive session's words wait for it to be activated: matchMachine stops it below.
		if (machineOf(ref) !== id || !session || !canRun(next, ref)) {
			continue;
		}

		const moved =
			session.status === 'idle'
				? dispatchQueueHead(next, ref, { ...stamped, id: `${stamped.id}:drain` })
				: session.status === 'stopped' && session.queue.length > 0
					? startWorker(next, ref)
					: null;

		if (moved) {
			next = moved.state;
			effects.push(...moved.effects);
		}
	}

	// Its active sessions run there and its inactive ones do not, whatever its snapshot said.
	const matched = matchMachine(next, id);

	return { state: matched.state, effects: [...effects, ...matched.effects] };
};

export const reduceMachine = (
	state: State,
	input: MachineInput,
	stamped: Stamped,
	reduceInner: ReduceInner,
): ReducerResult => {
	switch (input.type) {
		case 'machines':
			return withoutEffects(applyConfigs(state, input.machines, stamped.at));

		case 'add_machine': {
			const host = input.host.trim();
			const existing = Object.values(state.machines).find((machine) => machine.host === host);

			if (!isValidHost(host) || existing) {
				return {
					state,
					effects: existing ? [say(`${existing.name} already connects to ${host}.`)] : [],
				};
			}

			const id = machineIdFor(host, Object.keys(state.machines));
			const name = input.name?.trim() || id;

			return withChange(state, [...toMachineConfigs(state), { id, host, name }], stamped.at, {
				kind: 'add',
				host,
				name,
			});
		}

		case 'rename_machine': {
			const name = input.name.trim();

			if (!state.machines[input.id] || !name) {
				return withoutEffects(state);
			}

			return withChange(
				state,
				toMachineConfigs(state).map((config) =>
					config.id === input.id ? { ...config, name } : config,
				),
				stamped.at,
				{ kind: 'rename', id: input.id, name },
			);
		}

		case 'remove_machine': {
			const machine = state.machines[input.id];

			if (!machine) {
				return withoutEffects(state);
			}

			const queued = state.order.filter(
				(ref) => machineOf(ref) === input.id && (state.sessions[ref]?.queue.length ?? 0) > 0,
			);
			const removed = withChange(
				state,
				toMachineConfigs(state).filter((config) => config.id !== input.id),
				stamped.at,
				{ kind: 'remove', id: input.id },
			);

			return {
				state: dropMachineAttachments(removed.state, input.id),
				effects: [
					...removed.effects,
					...(queued.length > 0
						? [say(`Removed ${machine.name}. Messages waiting for it were dropped.`)]
						: []),
				],
			};
		}

		case 'machine_status': {
			const machine = state.machines[input.id];

			// connected comes only from machine_resynced, once its snapshot is applied.
			if (!machine || input.status === 'connected') {
				return withoutEffects(state);
			}

			return withoutEffects({
				...state,
				machines: {
					...state.machines,
					[input.id]: {
						...machine,
						status: input.status,
						detail: input.detail ?? null,
						since: machine.status === input.status ? machine.since : stamped.at,
					},
				},
			});
		}

		case 'machine_resynced':
			return resync({ state, id: input.id, inputs: input.inputs, stamped, reduceInner });
	}
};

// The ref an action works on, to decide whether its machine can take it.
const readActionRef = (state: State, input: Input): string | null => {
	switch (input.type) {
		case 'send':
		case 'interrupt':
		case 'promote_queued':
		case 'promote_all_queued':
		case 'dev_start':
		case 'dev_stop':
		case 'dev_restart':
		case 'fix_dev':
			return input.ref;
		case 'answer_permission':
		case 'answer_question':
		case 'decline_question':
		case 'answer_plan':
		case 'answer_command':
		case 'answer_redirect':
			return state.asks.find((ask) => ask.id === input.askId)?.ref ?? null;
		case 'allow_denied':
			return state.denials.find((denial) => denial.id === input.denialId)?.ref ?? null;
		default:
			return null;
	}
};

const queueUntilBack = (
	state: State,
	input: Extract<Input, { type: 'send' }>,
	stamped: Stamped,
): State => {
	const message: QueuedMessage = {
		id: stamped.id,
		text: input.text,
		at: stamped.at,
		...(input.note ? { note: input.note } : {}),
		...(input.ack && input.ack.kind !== 'question' ? { reportOwed: true as const } : {}),
	};

	return updateSession(state, input.ref, (session: Session) => ({
		...session,
		needsUser: null,
		queue: [...session.queue, message],
	}));
};

// Only a connected machine takes what the reducer sends. Words wait in its queue; anything else is
// refused aloud, since what it acts on (a turn, an ask) may have moved on by the time it is back.
export const guardUnreachable = (
	state: State,
	input: Input,
	stamped: Stamped,
): ReducerResult | null => {
	const ref = readActionRef(state, input);

	if (!ref || isReachable(state, ref) || !state.sessions[ref]) {
		return null;
	}

	const name = readMachineTitle(state, machineOf(ref) ?? '');

	if (input.type === 'send') {
		return {
			state: queueUntilBack(state, input, stamped),
			// Where the words went, said once: no "Sent to …" after it. An inactive session's words wait
			// for its activation, not its machine: "…isn't active. Activate it?" says that.
			effects: isActive(state, ref)
				? [say(`${name} is out of reach. I'll send it when it's back.`, true)]
				: [],
		};
	}

	return { state, effects: [say(`${name} is out of reach right now.`)] };
};

// Switching to a machine says what waits there, and nothing when nothing does; moving within that
// machine says nothing new.
export const describeSwitch = (state: State, next: View): Effect[] => {
	if (next.kind !== 'activate' || !next.machine || !hasMachines(state)) {
		return [];
	}

	const waiting =
		currentMachine(state) === next.machine ? '' : describeMachineWaiting(state, next.machine);

	return waiting ? [say(waiting)] : [];
};
