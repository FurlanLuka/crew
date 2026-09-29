// Other machines, read the same way by the server, the kernel's tools and the page.

import { LOCAL_MACHINE, machineOf, readMachine } from './machine-ref.js';
import type { MachineConfig, State, View } from './protocol.js';

// What ssh is given as its destination: a host alias or user@host, never something it would read as
// an option.
export const isValidHost = (host: string): boolean =>
	/^[A-Za-z0-9_][A-Za-z0-9._@-]{0,199}$/.test(host);

const MAX_ID_BASE = 56;

// crew's Go side (crew voice machines) derives ids the same way: keep the two in step.
export const machineIdFor = (host: string, taken: string[]): string => {
	const address = host.replace(/^[^@]*@/, '');
	// An IP address is kept whole ("10-0-0-5"): its first part alone would be a bare number, which
	// both collides and sorts as an array index in a record.
	const label = /^\d+(?:\.\d+){3}$/.test(address) ? address : address.split('.')[0];
	// Capped so a numbered id still fits the 64 characters every reader of machines.json allows.
	const base =
		label
			?.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.slice(0, MAX_ID_BASE)
			.replace(/^-+|-+$/g, '') || 'remote';
	const reserved = new Set([...taken, LOCAL_MACHINE]);

	if (!reserved.has(base)) {
		return base;
	}

	for (let suffix = 2; ; suffix++) {
		const id = `${base}-${suffix}`;

		if (!reserved.has(id)) {
			return id;
		}
	}
};

export interface MachinesDiff {
	start: MachineConfig[];
	stop: string[];
}

// A rename changes only what is said and shown: the link to that machine stays up.
export const diffMachines = (previous: MachineConfig[], next: MachineConfig[]): MachinesDiff => {
	const hostOf = new Map(previous.map((machine) => [machine.id, machine.host]));
	const nextIds = new Set(next.map((machine) => machine.id));

	return {
		start: next.filter((machine) => hostOf.get(machine.id) !== machine.host),
		stop: previous
			.filter(
				(machine) =>
					!nextIds.has(machine.id) ||
					next.find((other) => other.id === machine.id)?.host !== machine.host,
			)
			.map((machine) => machine.id),
	};
};

export const hasMachines = (state: State): boolean => Object.keys(state.machines).length > 0;

export const toMachineConfigs = (state: State): MachineConfig[] =>
	Object.values(state.machines).map(({ id, host, name }) => ({ id, host, name }));

// What a machine is called, this Mac included: the one spelling for speech, the page and the kernel.
export const readMachineTitle = (state: State, machine: string): string =>
	machine === LOCAL_MACHINE ? 'This Mac' : (state.machines[machine]?.name ?? machine);

// Only a connected machine takes what the reducer decides to send; this Mac always does.
export const isMachineReachable = (state: State, machine: string): boolean =>
	state.machines[machine]?.status === 'connected';

export const isReachable = (state: State, ref: string): boolean => {
	const machine = machineOf(ref);

	return machine === null || isMachineReachable(state, machine);
};

export const readMachineName = (state: State, ref: string): string | null => {
	const machine = machineOf(ref);

	return machine ? (state.machines[machine]?.name ?? machine) : null;
};

// The machine the developer is in: LOCAL_MACHINE or a machine id; null on a view of every machine.
export const currentMachine = (state: State): string | null => {
	const { view } = state;

	if (view.kind === 'session') {
		return readMachine(view.ref);
	}

	return view.kind === 'grid' ? (view.machine ?? null) : null;
};

// Home is always Mission Control's cards: This Mac, each other machine, and where one is added.
export const HOME_VIEW: View = { kind: 'machines' };

// Esc, "go back": a session → its machine's grid → home.
export const parentView = (state: State): View => {
	const { view } = state;

	return view.kind === 'session' ? { kind: 'grid', machine: readMachine(view.ref) } : HOME_VIEW;
};

// Asks and a "needs you" line: what the counts, the cards, the recap and Elsewhere all mean by waiting.
// machine: undefined for every machine, LOCAL_MACHINE or an id for one.
export const listWaitingRefs = (state: State, machine?: string): string[] => {
	const waiting = new Set([
		...state.asks.map((ask) => ask.ref),
		...Object.values(state.sessions)
			.filter((session) => session.needsUser)
			.map((session) => session.ref),
	]);

	const place = (ref: string): number => {
		const index = state.order.indexOf(ref);

		return index < 0 ? Number.MAX_SAFE_INTEGER : index;
	};

	return [...waiting]
		.filter((ref) => machine === undefined || readMachine(ref) === machine)
		.sort((left, right) => place(left) - place(right));
};

export const listMachineRefs = (state: State, machine: string): string[] =>
	Object.keys(state.sessions).filter((ref) => readMachine(ref) === machine);

const listNames = (labels: string[]): string => {
	if (labels.length <= 1) {
		return labels.join('');
	}

	return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
};

const readLabels = (state: State, refs: string[]): string[] =>
	refs.map((ref) => state.sessions[ref]?.label ?? ref);

// Said when the developer switches to a machine's grid.
export const describeMachineWaiting = (state: State, machine: string): string => {
	const name = readMachineTitle(state, machine);
	const waiting = readLabels(state, listWaitingRefs(state, machine));

	// The name alone says where the developer landed; "nothing is waiting" read as a problem.
	if (waiting.length === 0) {
		return `${name}.`;
	}

	return `${name}. ${listNames(waiting)} ${waiting.length === 1 ? 'is' : 'are'} waiting on you.`;
};

export interface DescribeRecapParams {
	name: string;
	finished: string[];
	waiting: string[];
}

// Said once when a machine comes back: what happened there while it was out of reach.
export const describeRecap = ({ name, finished, waiting }: DescribeRecapParams): string => {
	const parts = [
		finished.length > 0 ? `${listNames(finished)} finished` : '',
		waiting.length > 0
			? `${listNames(waiting)} ${waiting.length === 1 ? 'is' : 'are'} waiting on you`
			: '',
	].filter(Boolean);

	return parts.length > 0 ? `${name} is back: ${parts.join(', ')}.` : `${name} is back.`;
};
