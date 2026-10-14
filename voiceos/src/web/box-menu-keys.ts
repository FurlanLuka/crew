// The keys of a menu open above a text box (the "/" and "@" menus), pure: what a key does to it.
export type MenuKey =
	| { kind: 'move'; index: number }
	| { kind: 'close' }
	| { kind: 'choose' }
	| null;

interface ReadMenuKeyParams {
	key: string;
	isShift: boolean;
	// An input method composing a character: its Enter is the composition's, not the menu's.
	isComposing: boolean;
	index: number;
	length: number;
}

// Arrows wrap, Esc closes, Tab picks, Enter picks unless it is Shift+Enter (a new line) or the
// input method's own. null: the key is the box's.
export const readMenuKey = ({
	key,
	isShift,
	isComposing,
	index,
	length,
}: ReadMenuKeyParams): MenuKey => {
	if (length === 0) {
		return null;
	}

	switch (key) {
		case 'ArrowDown':
			return { kind: 'move', index: (index + 1) % length };
		case 'ArrowUp':
			return { kind: 'move', index: (index - 1 + length) % length };
		case 'Escape':
			return { kind: 'close' };
		case 'Tab':
			return { kind: 'choose' };
		case 'Enter':
			return isShift || isComposing ? null : { kind: 'choose' };
		default:
			return null;
	}
};
