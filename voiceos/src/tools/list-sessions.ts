// "What machines do I have?", "what's on Personal?", "what's active?", "what worktrees does scheduler
// have?": read-only, across every worktree. Heard, not read: counts first, names only when few.
import { isActive, listActiveRefs, listVoiceRefsOn } from '../shared/active.js';
import { LOCAL_MACHINE, readMachine, splitRef, CHAT_WORKSPACE } from '../shared/machine-ref.js';
import { isMachineReachable, readMachineTitle, readSessionLabel } from '../shared/machines.js';
import type { State } from '../shared/protocol.js';
import { toSpokenName } from '../shared/spoken.js';
import { normalizeName } from '../router/refs.js';
import { readLabel } from '../state/helpers.js';
import { findMachine } from './machines.js';
import { type ToolResult, fail, succeed } from './results.js';

// More than this and a list is a count: a long run of names is not heard.
export const MAX_NAMES_SAID = 6;

const plural = (count: number, word: string): string =>
	`${count === 0 ? 'no' : count} ${word}${count === 1 ? '' : 's'}`;

const isReachableMachine = (state: State, machine: string): boolean =>
	machine === LOCAL_MACHINE || isMachineReachable(state, machine);

// isMachineSaid: the line already names the machine ("Personal has …"), so each name goes without it.
const sayName = (state: State, ref: string, isMachineSaid: boolean): string => {
	const label = toSpokenName(isMachineSaid ? readSessionLabel(state, ref) : readLabel(state, ref));

	return isActive(state, ref) ? `${label} (active)` : label;
};

const describeActive = (state: State): string => {
	const refs = listActiveRefs(state);
	const names = refs.map((ref) => toSpokenName(readLabel(state, ref)));

	if (refs.length === 0) {
		return 'No sessions are active. A worktree is reached once it is activated.';
	}

	if (refs.length <= MAX_NAMES_SAID) {
		return `Active: ${names.join(', ')}.`;
	}

	return `${refs.length} sessions are active, on ${plural(new Set(refs.map(readMachine)).size, 'machine')}.`;
};

const describeMachines = (state: State): string => {
	const machines = [LOCAL_MACHINE, ...Object.keys(state.machines)];

	return `${machines
		.map((machine) => {
			const worktrees = listVoiceRefsOn(state, machine);
			const active = worktrees.filter((ref) => isActive(state, ref)).length;
			const reach = isReachableMachine(state, machine) ? '' : ', out of reach';

			return `${readMachineTitle(state, machine)}: ${plural(worktrees.length, 'worktree')}, ${active} active${reach}`;
		})
		.join('; ')}.`;
};

const describeWorktrees = (
	state: State,
	refs: string[],
	place: string,
	isMachineSaid: boolean,
): string => {
	const active = refs.filter((ref) => isActive(state, ref)).length;
	const workspaces = [...new Set(refs.map((ref) => splitRef(ref).workspace))];

	if (refs.length <= MAX_NAMES_SAID) {
		return refs.length === 0
			? `${place} has no worktrees.`
			: `${place} has ${refs.map((ref) => sayName(state, ref, isMachineSaid)).join(', ')}.`;
	}

	return `${place} has ${plural(refs.length, 'worktree')} in ${plural(workspaces.length, 'workspace')}; ${active === 0 ? 'none' : active} active. Workspaces: ${workspaces.map((name) => (name === CHAT_WORKSPACE ? 'plain sessions' : name)).join(', ')}. Ask which workspace.`;
};

interface DescribeSessionListParams {
	state: State;
	// A machine id (LOCAL_MACHINE for this Mac), when one was asked about.
	machine: string | null;
	workspace: string | null;
	isActiveOnly: boolean;
}

export const describeSessionList = ({
	state,
	machine,
	workspace,
	isActiveOnly,
}: DescribeSessionListParams): string => {
	if (isActiveOnly) {
		return describeActive(state);
	}

	if (workspace) {
		const wanted = normalizeName(workspace);
		const refs = listVoiceRefsOn(state, machine).filter(
			(ref) => normalizeName(splitRef(ref).workspace) === wanted,
		);
		const machines = [...new Set(refs.map(readMachine))];
		const place =
			machines.length === 1
				? `${workspace} on ${readMachineTitle(state, machines[0] ?? LOCAL_MACHINE)}`
				: workspace;

		return describeWorktrees(state, refs, place, machines.length === 1);
	}

	if (machine) {
		const title = readMachineTitle(state, machine);
		const listed = describeWorktrees(state, listVoiceRefsOn(state, machine), title, true);

		return isReachableMachine(state, machine)
			? listed
			: `${title} is out of reach; last known: ${listed}`;
	}

	return describeMachines(state);
};

export const listSessions = (state: State, input: Record<string, unknown>): ToolResult => {
	const machineSaid =
		typeof input.machine === 'string' && input.machine.trim() ? input.machine : null;
	const machine = machineSaid ? findMachine(state, machineSaid) : null;

	if (machineSaid && !machine) {
		return fail(
			`No machine called ${machineSaid}. Machines: ${[LOCAL_MACHINE, ...Object.keys(state.machines)].map((id) => readMachineTitle(state, id)).join(', ')}.`,
		);
	}

	const workspace =
		typeof input.workspace === 'string' && input.workspace.trim() ? input.workspace.trim() : null;

	return succeed(
		`${describeSessionList({ state, machine, workspace, isActiveOnly: input.active_only === true })} Say this in a few words.`,
	);
};
