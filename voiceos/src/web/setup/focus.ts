// Which worktree the setup chat is on, pure: the last one named in the crew commands Claude ran or
// in the messages sent to it. Only a ref this machine lists counts, and never one inside a path or
// a branch name (~/.crew/workspaces/store/main/…, crew/store/main/api).
import type { StreamItem } from '../../shared/protocol.js';
import { splitCommandLine } from './recorded.js';

export interface Focus {
	ref: string;
	// The stream item that named it, and where it sits: a close is remembered by the one, an ask
	// from a button is ordered against the other.
	atId: string;
	index: number;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A ref inside a path, a branch or a file name has a slash, a dot or a word character against one
// of its ends; a sentence's own full stop after it does not count.
const refPattern = (ref: string): RegExp =>
	new RegExp(`(?<![\\w./~-])${escapeRegExp(ref)}(?![\\w/-]|\\.\\w)`, 'g');

// The last listed ref the text names, by where it is named.
export const findRefIn = (text: string, refs: string[]): string | null => {
	let found: { ref: string; at: number } | null = null;

	for (const ref of refs) {
		for (const match of text.matchAll(refPattern(ref))) {
			if (!found || match.index > found.at) {
				found = { ref, at: match.index };
			}
		}
	}

	return found?.ref ?? null;
};

// crew takes a bare <ws> for a workspace with one worktree: in a crew command, that word is it.
const bareWorkspaceIn = (command: string, refs: string[]): string | null => {
	const words = splitCommandLine(command);
	const start = words.indexOf('crew');

	if (start < 0) {
		return null;
	}

	const named = words
		.slice(start + 1)
		.filter((word) => !word.startsWith('-'))
		.map((word) => refs.filter((ref) => ref.startsWith(`${word}/`)))
		.filter((matches) => matches.length === 1);

	return named.at(-1)?.[0] ?? null;
};

const readNamed = (item: StreamItem, refs: string[]): string | null => {
	if (item.kind === 'user') {
		return findRefIn(item.text, refs);
	}

	if (item.kind === 'tool' && item.name === 'Bash' && item.summary.startsWith('run ')) {
		const command = item.summary.slice('run '.length);

		if (!/\bcrew\b/.test(command)) {
			return null;
		}

		return findRefIn(command, refs) ?? bareWorkspaceIn(command, refs);
	}

	return null;
};

export interface FindFocusParams {
	stream: StreamItem[];
	// Every worktree this machine lists, as crew names them (store/main).
	refs: string[];
}

export const findFocus = ({ stream, refs }: FindFocusParams): Focus | null => {
	for (let index = stream.length - 1; index >= 0; index--) {
		const item = stream[index];
		const ref = item ? readNamed(item, refs) : null;

		if (item && ref) {
			return { ref, atId: item.id, index };
		}
	}

	return null;
};

// A worktree named by a "Fix with Claude" before anything is sent: it holds until the stream names
// one after it.
export interface AskedFocus {
	ref: string;
	afterIndex: number;
}

export interface PickFocusParams {
	found: Focus | null;
	asked: AskedFocus | null;
	// The mention the developer closed the panel on; a newer one opens it again.
	closedAt: string | null;
}

export interface ShownFocus {
	ref: string;
	// What a close remembers: this mention, so only a newer one opens the panel again.
	closeKey: string;
}

export const pickFocus = ({ found, asked, closedAt }: PickFocusParams): ShownFocus | null => {
	const shown =
		asked && (!found || found.index < asked.afterIndex)
			? { ref: asked.ref, closeKey: `ask ${asked.afterIndex}` }
			: found
				? { ref: found.ref, closeKey: found.atId }
				: null;

	return shown && shown.closeKey !== closedAt ? shown : null;
};
