// The keys of a menu open above a text box (the "/" and "@" menus): what a key does to it (pure),
// and the one handler both menus run.
import type { KeyboardEvent } from 'react';

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

interface ApplyMenuKeyParams {
	index: number;
	length: number;
	onMove: (index: number) => void;
	onClose: () => void;
	onChoose: () => void;
}

// The box's key, taken by the menu when it means something to it; true when it did.
export const applyMenuKey = (
	event: KeyboardEvent,
	{ index, length, onMove, onClose, onChoose }: ApplyMenuKeyParams,
): boolean => {
	const menuKey = readMenuKey({
		key: event.key,
		isShift: event.shiftKey,
		isComposing: event.nativeEvent.isComposing,
		index,
		length,
	});

	if (!menuKey) {
		return false;
	}

	if (menuKey.kind === 'move') {
		onMove(menuKey.index);
	} else if (menuKey.kind === 'close') {
		onClose();
	} else {
		onChoose();
	}

	event.preventDefault();

	return true;
};
