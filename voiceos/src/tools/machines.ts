// The kernel's words about machines: which one the developer named, and renaming one.

import { LOCAL_MACHINE, joinRef, toLocalRef } from '../shared/machine-ref.js';
import type { State } from '../shared/protocol.js';
import { normalizeName } from '../router/refs.js';

// Never a word a machine's own id could be (machineIdFor reserves only local).
const THIS_MAC_NAMES = new Set(['thismac', 'mymac', 'local', 'here', 'thismachine']);

// A machine as the developer said it: its id or its name, or this Mac. null: none matches.
// Said around a name, not part of it: "the personal server", "build box machine".
const MACHINE_WORDS = /\s+(?:server|machine|remote|computer|vm|box|host)$/i;

export const findMachine = (state: State, said: string): string | null => {
	const trimmed = said.trim().replace(/^the\s+/i, '');
	const wanted = normalizeName(trimmed);
	const bare = normalizeName(trimmed.replace(MACHINE_WORDS, ''));

	if (!wanted) {
		return null;
	}

	if (THIS_MAC_NAMES.has(wanted)) {
		return LOCAL_MACHINE;
	}

	const names = (machine: { id: string; name: string }) => [
		normalizeName(machine.id),
		normalizeName(machine.name),
	];
	const exact = Object.values(state.machines).find((machine) => names(machine).includes(wanted));
	const loose = Object.values(state.machines).find((machine) => names(machine).includes(bare));

	return (exact ?? loose)?.id ?? null;
};

const THIS_MAC_SAID = /\b(?:on|in|into|at)\s+(?:my|this)\s+mac\b/i;

// The machine the developer's words put a session on ("crew main on my Mac", "sch in Personal"),
// when they said one. null: they named none.
export const findMachineSaid = (state: State, utterance: string | undefined): string | null => {
	if (!utterance) {
		return null;
	}

	if (THIS_MAC_SAID.test(utterance)) {
		return LOCAL_MACHINE;
	}

	const words = ` ${normalizeSpaces(utterance)} `;
	const named = Object.values(state.machines).find((machine) =>
		[machine.name, machine.id].some((name) =>
			new RegExp(`\\b(?:on|in|into|at)\\s+(?:the\\s+)?${escapeRegExp(name.toLowerCase())}\\b`).test(
				words,
			),
		),
	);

	return named?.id ?? null;
};

const normalizeSpaces = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The same session on the machine asked for: "crew main" resolved elsewhere, wanted on this Mac.
export const onMachine = (state: State, ref: string, machine: string): string | null => {
	const scoped = joinRef(machine === LOCAL_MACHINE ? null : machine, toLocalRef(ref));

	return state.sessions[scoped] ? scoped : null;
};

export const listMachineNames = (state: State): string =>
	['this Mac', ...Object.values(state.machines).map((machine) => machine.name)].join(', ');
