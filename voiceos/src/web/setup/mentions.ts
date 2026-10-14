// The setup chat's "@" menu, pure: the "@word" the caret is at, the worktrees and projects it could
// be, and the box's text once one is picked. A pick puts in the name as crew spells it, no "@".
export interface Mention {
	// Where the "@" is, and the caret: what a pick replaces.
	start: number;
	end: number;
	typed: string;
}

const MENTION_CHAR = /[\w./-]/;

// An "@" starts a mention at the box's start or after a space, so mail@host and a@b are not one.
export const readMention = (text: string, caret: number): Mention | null => {
	let start = caret;

	while (start > 0 && MENTION_CHAR.test(text[start - 1] ?? '')) {
		start--;
	}

	const at = start - 1;

	if (text[at] !== '@' || (at > 0 && !/\s/.test(text[at - 1] ?? ''))) {
		return null;
	}

	return { start: at, end: caret, typed: text.slice(start, caret) };
};

export interface MentionEntry {
	value: string;
	kind: 'worktree' | 'project';
}

const SHOWN = 8;

const rank = (value: string, typed: string): number =>
	value.startsWith(typed) ? 0 : value.split(/[/-]/).some((part) => part.startsWith(typed)) ? 1 : 2;

export const filterMentions = (
	typed: string,
	worktrees: string[],
	projects: string[],
): MentionEntry[] => {
	const query = typed.toLowerCase();
	const all: MentionEntry[] = [
		...worktrees.map((value) => ({ value, kind: 'worktree' as const })),
		...projects.map((value) => ({ value, kind: 'project' as const })),
	];

	return all
		.filter((entry) => entry.value.toLowerCase().includes(query))
		.map((entry, order) => ({ entry, order, rank: rank(entry.value.toLowerCase(), query) }))
		.sort((a, b) => a.rank - b.rank || a.order - b.order)
		.slice(0, SHOWN)
		.map(({ entry }) => entry);
};

export const insertMention = (
	text: string,
	mention: Mention,
	value: string,
): { text: string; caret: number } => {
	const before = `${text.slice(0, mention.start)}${value} `;

	return { text: `${before}${text.slice(mention.end).replace(/^ /, '')}`, caret: before.length };
};
