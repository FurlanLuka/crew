import type { State } from '../shared/protocol.js';
import { splitRef } from '../shared/machine-ref.js';
import { toSpokenPart, NUMBER_WORDS } from '../shared/spoken.js';
import type { ToolContext } from './tools.js';

const listSpokenForms = (worktree: string): string[] => {
	const numbered = worktree.match(/^wrk(\d)$/);

	if (!numbered?.[1]) {
		return [worktree];
	}

	const digit = numbered[1];

	return [worktree, toSpokenPart(worktree), `work ${NUMBER_WORDS[Number(digit)]}`];
};

const isWorktreeSaid = (text: string, worktree: string): boolean => {
	return listSpokenForms(worktree).some((form) => text.includes(` ${form} `));
};

interface IsSessionNamedParams {
	ref: string;
	text: string;
	words: Set<string>;
	order: string[];
}

export const isSessionNamed = ({ ref, text, words, order }: IsSessionNamedParams): boolean => {
	const { workspace, worktree } = splitRef(ref);

	if (workspace.split('-').some((part) => part.length >= 4 && words.has(part))) {
		const siblingRefs = order.filter((other) => splitRef(other).workspace === workspace);

		if (siblingRefs.length === 1 || worktree === '' || isWorktreeSaid(text, worktree)) {
			return true;
		}
	}

	// "main" alone names nothing: every workspace has one.
	return Boolean(worktree && worktree !== 'main' && isWorktreeSaid(text, worktree));
};

// Words only, each side padded: "voice os dev" is said in "go to voice-os dev.", never inside "devops".
const toPlainWords = (text: string): string =>
	` ${text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()} `;

// A display name names its session in full: the developer chose it to be told apart.
const isDisplayNameSaid = (name: string | undefined, plain: string): boolean => {
	const words = name ? toPlainWords(name) : '';

	return words.trim() !== '' && plain.includes(words);
};

// "Speak main" said where the developer named a session "Speak Main": their own name wins over a
// worktree whose ref only sounds the same (speak/main), wherever either runs. null: keep `ref`.
export const readNamedInstead = (state: State, ref: string, utterance: string): string | null => {
	const plain = toPlainWords(utterance);

	if (isDisplayNameSaid(state.names[ref], plain)) {
		return null;
	}

	const named = state.order.filter(
		(other) => other !== ref && isDisplayNameSaid(state.names[other], plain),
	);

	return named.length === 1 ? (named[0] ?? null) : null;
};

export const findSessionsNamedIn = (state: State, utterance: string): string[] => {
	const text = ` ${utterance
		.toLowerCase()
		.replace(/[^a-z0-9/\s-]/g, ' ')
		.replace(/\s+/g, ' ')} `;
	const words = new Set(text.split(/[\s/-]+/).filter(Boolean));
	const plain = toPlainWords(utterance);
	const refsNamedInFull = state.order.filter(
		(ref) =>
			text.includes(splitRef(ref).local.toLowerCase()) ||
			isDisplayNameSaid(state.names[ref], plain),
	);

	if (refsNamedInFull.length > 0) {
		return refsNamedInFull;
	}

	return state.order.filter(
		(ref) => state.sessions[ref] && isSessionNamed({ ref, text, words, order: state.order }),
	);
};

export const findNamedRefs = async (
	state: State,
	toolContext: ToolContext,
	ref: string,
): Promise<string[]> => {
	if (toolContext.utterance === undefined) {
		return [ref];
	}

	const namedRefs = findSessionsNamedIn(state, toolContext.utterance);

	// "end this session" names the one on screen — unless another is named ("the checkout one, not this one").
	if (
		namedRefs.length === 0 &&
		toolContext.screen &&
		(await toolContext.judge({ key: 'this_session', utterance: toolContext.utterance })) === 'yes'
	) {
		return [toolContext.screen];
	}

	const previousUtterance = toolContext.recentUtterances?.at(-1);

	if (namedRefs.length > 0 || !previousUtterance) {
		return namedRefs;
	}

	return findSessionsNamedIn(state, `${previousUtterance} ${toolContext.utterance}`);
};
