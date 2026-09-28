import type { Session, State } from '../shared/protocol.js';
import { NUMBER_WORDS } from '../shared/spoken.js';
import { readMachine, splitRef } from '../shared/machine-ref.js';
import { currentMachine, readMachineName } from '../shared/machines.js';

export type UtteranceSource = 'voice' | 'typed';

const DIGIT_WORDS: Record<string, string> = Object.fromEntries(
	NUMBER_WORDS.map((word, digit) => [word, String(digit)]),
);

export const normalizeName = (text: string): string => {
	const words = text
		.toLowerCase()
		.split(/[\s\-_/]+/)
		.map((word) => DIGIT_WORDS[word] ?? word);

	return words
		.join('')
		.replace(/[^a-z0-9]/g, '')
		.replace(/^work(?=\d)/, 'wrk')
		.replace(/(?<=[a-z])work(?=\d)/, 'wrk');
};

const listAliases = (session: Session, machineName: string | null): string[] => {
	const { local, workspace, worktree } = splitRef(session.ref);
	const names = [
		local,
		session.label,
		worktree,
		`${workspace} ${worktree}`,
		`${worktree} in ${workspace}`,
		...(session.isPinned ? ['setup session', 'setup'] : []),
	].filter(Boolean);
	// Another machine's session also answers to its name in front: "build box store-front wrk1".
	const aliases = new Set(
		machineName ? [...names, ...names.map((name) => `${machineName} ${name}`)] : names,
	);

	return [...aliases].map(normalizeName);
};

const escapeRegExp = (text: string): string => {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const buildWorktreePattern = (worktree: string): string => {
	const numbered = worktree.match(/^wrk(\d+)$/);

	if (!numbered?.[1]) {
		return worktree.split('-').map(escapeRegExp).join('[\\s-]+');
	}

	const worktreeNumber = Number(numbered[1]);
	const numberWord = NUMBER_WORDS[worktreeNumber];

	return `(?:w(?:o)?rk\\s*${worktreeNumber}${numberWord ? `|work\\s+${numberWord}` : ''})`;
};

const rewriteSpokenRef = (text: string, ref: string): string => {
	const { workspace, worktree } = splitRef(ref);

	if (!workspace || !worktree) {
		return text;
	}

	const workspacePattern = workspace.split('-').map(escapeRegExp).join('[\\s-]+');
	const pattern = new RegExp(
		`(?<![\\w/-])${workspacePattern}(?:\\s+slash\\s+|\\s*/\\s*|,?\\s+)${buildWorktreePattern(worktree)}(?![\\w/-])`,
		'gi',
	);

	return text.replace(pattern, ref);
};

interface WriteSpokenRefsParams {
	text: string;
	refs: string[];
}

export const writeSpokenRefs = ({ text, refs }: WriteSpokenRefsParams): string => {
	// Display only: what is routed and sent keeps the words as said.
	return refs.reduce((written, ref) => rewriteSpokenRef(written, ref), text);
};

export const resolveRef = (state: State, phrase: string): string | null => {
	// Exact alias matches only: anything fuzzier (topics, "the checkout work") belongs to the kernel.
	// "the crew main session" names crew/main as much as "crew main" does.
	const wantedName = normalizeName(
		phrase.replace(/^the\s+/, '').replace(/\s+(?:session|worktree|workspace)$/, ''),
	);

	if (!wantedName) {
		return null;
	}

	const matchingRefs = state.order.filter((ref) => {
		const session = state.sessions[ref];

		return session ? listAliases(session, readMachineName(state, ref)).includes(wantedName) : false;
	});

	if (matchingRefs.length === 1) {
		return matchingRefs[0] ?? null;
	}

	// The same name on several machines: the one the developer is in.
	const machine = currentMachine(state);
	const onThisMachine = machine
		? matchingRefs.filter((ref) => readMachine(ref) === machine)
		: matchingRefs;

	if (onThisMachine.length === 1) {
		return onThisMachine[0] ?? null;
	}

	if (onThisMachine.length > 1 && state.focus) {
		const focusedWorkspace = splitRef(state.focus).workspace;
		const sameWorkspaceRefs = onThisMachine.filter(
			(ref) => splitRef(ref).workspace === focusedWorkspace,
		);

		if (sameWorkspaceRefs.length === 1) {
			return sameWorkspaceRefs[0] ?? null;
		}
	}

	return null;
};

const findAddressedRef = (state: State, text: string): string | null => {
	const namedPhrase = text.match(/^\s*([^,:]{1,60})[,:]\s*\S/)?.[1];

	return namedPhrase ? resolveRef(state, namedPhrase) : null;
};

export const readActiveRef = (state: State): string | null => {
	return state.view.kind === 'session' ? state.view.ref : null;
};

export const resolveTypedTarget = (state: State, text: string): string | null => {
	const activeRef = readActiveRef(state);

	// A waiting session is answered by the kernel: a typed "yes" must not deny a permission.
	if (!activeRef || !state.sessions[activeRef] || state.asks.some((ask) => ask.ref === activeRef)) {
		return null;
	}

	// Text addressed to another session by name is not this Claude's input.
	const addressedRef = findAddressedRef(state, text);

	return addressedRef && addressedRef !== activeRef ? null : activeRef;
};
