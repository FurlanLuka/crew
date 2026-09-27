import type { State } from '../shared/protocol.js';
import { listSessionDocs, type SessionDoc } from '../shared/session-docs.js';

// Opens a url in the developer's tab; false when no tab took it.
export type OpenUrl = (url: string, title: string) => boolean;

// Words that name the kind of thing, not which one: "the risks doc" is the doc about risks.
const GENERIC_WORDS = new Set([
	'the',
	'a',
	'an',
	'doc',
	'docs',
	'document',
	'artifact',
	'page',
	'that',
	'this',
	'one',
]);

// Spoken as heard: "the risk doc" is the one titled "Retry risks".
const readTitleWords = (text: string): string[] =>
	text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word && !GENERIC_WORDS.has(word))
		.map((word) => (word.length > 3 ? word.replace(/s$/, '') : word));

interface FindDocToOpenParams {
	state: State;
	ref: string;
	// Words from the title the developer named; null for the newest.
	title: string | null;
}

export const findDocToOpen = ({ state, ref, title }: FindDocToOpenParams): SessionDoc | null => {
	const docs = listSessionDocs(state.sessions[ref]?.stream ?? []);
	const wanted = readTitleWords(title ?? '');

	if (wanted.length === 0) {
		return docs[0] ?? null;
	}

	return (
		docs.find((doc) => wanted.every((word) => readTitleWords(doc.title).includes(word))) ?? null
	);
};

// The titles the kernel sees on a session, newest first: enough to match "the risks doc".
export const listDocTitles = (state: State, ref: string, limit = 3): string[] =>
	listSessionDocs(state.sessions[ref]?.stream ?? [])
		.slice(0, limit)
		.map((doc) => doc.title);
