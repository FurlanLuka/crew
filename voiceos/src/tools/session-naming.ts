import type { State } from '../shared/protocol.js';
import { toSpokenPart, NUMBER_WORDS } from '../shared/spoken.js';
import type { ToolContext } from './tools.js';

const TOPIC_WORD_PATTERN = /^[a-z]{4,}$/;

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
	topic: string | null;
	text: string;
	words: Set<string>;
	order: string[];
}

export const isSessionNamed = ({
	ref,
	topic,
	text,
	words,
	order,
}: IsSessionNamedParams): boolean => {
	const [workspace = '', worktree = ''] = ref.split('/');

	if (workspace.split('-').some((part) => part.length >= 4 && words.has(part))) {
		const siblingRefs = order.filter((other) => other.startsWith(`${workspace}/`));

		if (siblingRefs.length === 1 || worktree === '' || isWorktreeSaid(text, worktree)) {
			return true;
		}
	}

	// "main" alone names nothing: every workspace has one.
	if (worktree && worktree !== 'main' && isWorktreeSaid(text, worktree)) {
		return true;
	}

	const topicWords = (topic ?? '')
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => TOPIC_WORD_PATTERN.test(word));

	return topicWords.filter((word) => words.has(word)).length >= 2;
};

export const findSessionsNamedIn = (state: State, utterance: string): string[] => {
	const text = ` ${utterance
		.toLowerCase()
		.replace(/[^a-z0-9/\s-]/g, ' ')
		.replace(/\s+/g, ' ')} `;
	const words = new Set(text.split(/[\s/-]+/).filter(Boolean));
	const refsNamedInFull = state.order.filter((ref) => text.includes(ref.toLowerCase()));

	if (refsNamedInFull.length > 0) {
		return refsNamedInFull;
	}

	return state.order.filter(
		(ref) =>
			state.sessions[ref] &&
			isSessionNamed({ ref, topic: state.sessions[ref].topic, text, words, order: state.order }),
	);
};

const THIS_SESSION_PATTERN = /\b(?:this|the current) (?:session|one|claude)\b/i;

export const findNamedRefs = (state: State, toolContext: ToolContext, ref: string): string[] => {
	if (toolContext.utterance === undefined) {
		return [ref];
	}

	const namedRefs = findSessionsNamedIn(state, toolContext.utterance);

	// "end this session" names the one on screen — unless another is named ("the checkout one, not this one").
	if (
		namedRefs.length === 0 &&
		toolContext.screen &&
		THIS_SESSION_PATTERN.test(toolContext.utterance)
	) {
		return [toolContext.screen];
	}

	const previousUtterance = toolContext.recentUtterances?.at(-1);

	if (namedRefs.length > 0 || !previousUtterance) {
		return namedRefs;
	}

	return findSessionsNamedIn(state, `${previousUtterance} ${toolContext.utterance}`);
};
