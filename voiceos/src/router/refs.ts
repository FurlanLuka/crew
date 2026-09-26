import type { Session, State } from '../shared/protocol.js';
import { NUMBER_WORDS } from '../shared/spoken.js';

export type UtteranceSource = 'voice' | 'typed';

const DIGIT_WORDS: Record<string, string> = Object.fromEntries(
	NUMBER_WORDS.map((word, digit) => [word, String(digit)]),
);

const normalizeName = (text: string): string => {
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

const listAliases = (session: Session): string[] => {
	const [workspace = '', worktree = ''] = session.ref.split('/');
	const aliases = new Set(
		[
			session.ref,
			session.label,
			worktree,
			`${workspace} ${worktree}`,
			`${worktree} in ${workspace}`,
		].filter(Boolean),
	);

	if (session.isPinned) {
		aliases.add('voice os');
	}

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
	const [workspace, worktree] = ref.split('/');

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

		return session ? listAliases(session).includes(wantedName) : false;
	});

	if (matchingRefs.length === 1) {
		return matchingRefs[0] ?? null;
	}

	if (matchingRefs.length > 1 && state.focus) {
		const focusedWorkspace = state.focus.split('/')[0];
		const sameWorkspaceRefs = matchingRefs.filter((ref) => ref.split('/')[0] === focusedWorkspace);

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
