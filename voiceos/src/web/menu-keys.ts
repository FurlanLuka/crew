// The page's small menus share their manners: arrows move (and wrap), Esc closes the menu alone,
// Tab leaves it, a press outside closes it.
import { type KeyboardEvent, type RefObject, useEffect } from 'react';

export const MENU_ITEMS = '[role^="menuitem"]';

interface MenuKeyParams {
	// What the arrows move between.
	stops?: string;
	onEscape: () => void;
	onTab: () => void;
}

export const handleMenuKey = (
	event: KeyboardEvent<HTMLElement>,
	{ stops = MENU_ITEMS, onEscape, onTab }: MenuKeyParams,
): void => {
	const items = [...event.currentTarget.querySelectorAll<HTMLElement>(stops)];
	const active = document.activeElement;
	const focused = active instanceof HTMLElement ? items.indexOf(active) : -1;

	const move = (step: number) => {
		event.preventDefault();
		items[(focused + step + items.length) % items.length]?.focus();
	};

	switch (event.key) {
		case 'ArrowDown':
			move(1);
			break;
		case 'ArrowUp':
			move(-1);
			break;
		case 'Escape':
			event.preventDefault();
			// The page's own Esc would also leave the view.
			event.stopPropagation();
			onEscape();
			break;
		case 'Tab':
			onTab();
			break;
	}
};

export const useClickOutside = (
	isOpen: boolean,
	wrapRef: RefObject<HTMLElement | null>,
	onOutside: () => void,
): void => {
	useEffect(() => {
		if (!isOpen) {
			return;
		}

		const closeOutside = (event: PointerEvent) => {
			if (event.target instanceof Node && !wrapRef.current?.contains(event.target)) {
				onOutside();
			}
		};

		document.addEventListener('pointerdown', closeOutside);

		return () => document.removeEventListener('pointerdown', closeOutside);
	}, [isOpen, wrapRef, onOutside]);
};
