// The setup chat's "@" menu: what the caret is at, the entries it could be, and its keys. The caret
// is followed from the box's own events; a pick puts it after the name.
import {
	type KeyboardEvent,
	type RefObject,
	type SyntheticEvent,
	useEffect,
	useState,
} from 'react';
import { applyMenuKey } from '../box-menu-keys.js';
import { type MentionEntry, filterMentions, insertMention, readMention } from './mentions.js';

export interface Mentions {
	entries: MentionEntry[];
	selected: number;
	choose: (entry: MentionEntry) => void;
	// The box's keys while the menu is open; true when it took the key.
	handleKey: (event: KeyboardEvent) => boolean;
	// The box's change, select and click events: where the caret is now.
	follow: (event: SyntheticEvent<HTMLInputElement>) => void;
}

interface UseMentionsParams {
	text: string;
	setText: (text: string) => void;
	fieldRef: RefObject<HTMLInputElement | null>;
	worktrees: string[];
	projects: string[];
}

export const useMentions = ({
	text,
	setText,
	fieldRef,
	worktrees,
	projects,
}: UseMentionsParams): Mentions => {
	const [caret, setCaret] = useState(text.length);
	const [selected, setSelected] = useState(0);
	// Esc closes the menu until the text changes.
	const [closedFor, setClosedFor] = useState<string | null>(null);
	const mention = readMention(text, Math.min(caret, text.length));
	const entries =
		mention && closedFor !== text ? filterMentions(mention.typed, worktrees, projects) : [];
	const index = Math.min(selected, Math.max(entries.length - 1, 0));

	useEffect(() => setSelected(0), [mention?.typed]);

	const choose = (entry: MentionEntry): void => {
		if (!mention) {
			return;
		}

		const next = insertMention(text, mention, entry.value);

		setText(next.text);
		setCaret(next.caret);
		requestAnimationFrame(() => fieldRef.current?.setSelectionRange(next.caret, next.caret));
	};

	const handleKey = (event: KeyboardEvent): boolean => {
		const entry = entries[index];

		return (
			Boolean(entry) &&
			applyMenuKey(event, {
				index,
				length: entries.length,
				onMove: setSelected,
				onClose: () => setClosedFor(text),
				onChoose: () => entry && choose(entry),
			})
		);
	};

	return {
		entries,
		selected: index,
		choose,
		handleKey,
		follow: (event) =>
			setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length),
	};
};
