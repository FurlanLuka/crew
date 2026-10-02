import type { State } from '../shared/protocol.js';
import { splitRef } from '../shared/machine-ref.js';
import { readGivenName } from '../shared/machines.js';
import { listActiveInOrder } from '../shared/active.js';
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
export const toPlainWords = (text: string): string =>
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

	if (isDisplayNameSaid(readGivenName(state, ref), plain)) {
		return null;
	}

	// Only a name that sounds like the ref asked for: another named session mentioned beside a
	// different target ("tell speak main…, then switch to checkout") changes nothing.
	const asked = toPlainWords(splitRef(ref).local);
	const named = state.order.filter(
		(other) =>
			other !== ref &&
			isDisplayNameSaid(readGivenName(state, other), plain) &&
			toPlainWords(readGivenName(state, other) ?? '') === asked,
	);

	return named.length === 1 ? (named[0] ?? null) : null;
};

// The developer's own name for the session was said.
export const isOwnNameSaid = (state: State, ref: string, utterance: string): boolean =>
	isDisplayNameSaid(readGivenName(state, ref), toPlainWords(utterance));

interface NamingText {
	// Slashes and dashes kept: "checkout-api/main" is said in full.
	text: string;
	words: Set<string>;
}

const readNamingText = (utterance: string): NamingText => {
	const text = ` ${utterance
		.toLowerCase()
		.replace(/[^a-z0-9/\s-]/g, ' ')
		.replace(/\s+/g, ' ')} `;

	return { text, words: new Set(text.split(/[\s/-]+/).filter(Boolean)) };
};

const isNamedInFull = (state: State, ref: string, utterance: string, text: string): boolean =>
	text.includes(splitRef(ref).local.toLowerCase()) ||
	isDisplayNameSaid(readGivenName(state, ref), toPlainWords(utterance));

// This one session named in the words, however many share its workspace: "checkout" names
// checkout-api/main and checkout-api/wrk1 alike. Which of them the words are for is not decided here.
export const isRefNamedIn = (state: State, ref: string, utterance: string): boolean => {
	const { text, words } = readNamingText(utterance);

	return (
		isNamedInFull(state, ref, utterance, text) || isSessionNamed({ ref, text, words, order: [ref] })
	);
};

// refs: who may be named; voice reaches only the active sessions unless told otherwise.
export const findSessionsNamedIn = (
	state: State,
	utterance: string,
	refs: string[] = listActiveInOrder(state),
): string[] => {
	const { text, words } = readNamingText(utterance);
	const refsNamedInFull = refs.filter((ref) => isNamedInFull(state, ref, utterance, text));

	if (refsNamedInFull.length > 0) {
		return keepLongestNames(state, refs, utterance, refsNamedInFull);
	}

	return refs.filter(
		(ref) => state.sessions[ref] && isSessionNamed({ ref, text, words, order: refs }),
	);
};

const toWordList = (text: string): string[] => toPlainWords(text).trim().split(' ');

// The words that named a session in full: the developer's name for it when said, else its ref.
const readNamedWords = (state: State, ref: string, plain: string): string[] =>
	isDisplayNameSaid(readGivenName(state, ref), plain)
		? toWordList(readGivenName(state, ref) ?? '')
		: toWordList(splitRef(ref).local);

// "crew research": the workspace and the worktree said together, as one phrase.
const readSaidTogether = (ref: string, plain: string): string[] | null => {
	const { workspace, worktree } = splitRef(ref);

	if (!worktree) {
		return null;
	}

	const said = listSpokenForms(worktree)
		.map((form) => toWordList(`${workspace} ${form}`))
		.find((phrase) => plain.includes(` ${phrase.join(' ')} `));

	return said ?? null;
};

const isStrictSubset = (part: string[], whole: string[]): boolean =>
	part.length < whole.length && part.every((word) => whole.includes(word));

// "Go back to crew research" with crew/main named "Crew": the name "Crew" is said inside "crew
// research", and only the longer phrase was meant (debug note 39). A session said as workspace and
// worktree together joins the full names when it contains one of them; then any name said only as part
// of a longer one drops out. Names that do not overlap all stay: which one is asked, never guessed.
const keepLongestNames = (
	state: State,
	refs: string[],
	utterance: string,
	namedInFull: string[],
): string[] => {
	const plain = toPlainWords(utterance);
	const named = new Map(namedInFull.map((ref) => [ref, readNamedWords(state, ref, plain)]));
	const fullPhrases = [...named.values()];

	for (const ref of refs) {
		const together = named.has(ref) || !state.sessions[ref] ? null : readSaidTogether(ref, plain);

		if (together && fullPhrases.some((phrase) => isStrictSubset(phrase, together))) {
			named.set(ref, together);
		}
	}

	const isInsideAnother = (ref: string, phrase: string[]): boolean =>
		[...named].some(([other, longer]) => other !== ref && isStrictSubset(phrase, longer));

	return refs.filter((ref) => {
		const phrase = named.get(ref);

		return phrase !== undefined && !isInsideAnother(ref, phrase);
	});
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
