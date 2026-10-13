// A tab's menu, however it is asked for: right-click, the Menu key (Shift+F10), or on a phone a held
// touch, whose tap does nothing else.
import { type MouseEvent, type PointerEvent, useEffect, useRef } from 'react';

const LONG_PRESS_MS = 500;
// A finger that moves this far is dragging or scrolling the bar, not pressing.
const MOVE_TOLERANCE_PX = 10;
// Android follows a held touch with its own contextmenu: the menu is already open.
const NATIVE_MENU_AFTER_MS = 1500;

export interface Spot {
	x: number;
	y: number;
}

// The Menu key and Shift+F10 open a context menu at 0,0: under the element instead.
export const readMenuSpot = (click: Spot, rect: { left: number; bottom: number }): Spot =>
	click.x !== 0 || click.y !== 0 ? click : { x: rect.left, y: rect.bottom };

const EDGE_PX = 8;

// A menu pressed near the right edge (a chip on a phone) opens leftwards enough to stay on screen.
export const fitSpot = (spot: Spot, width: number, viewportWidth: number): Spot => ({
	x: Math.max(EDGE_PX, Math.min(spot.x, viewportWidth - width - EDGE_PX)),
	y: spot.y,
});

export interface MenuPressHandlers {
	onPointerDown: (event: PointerEvent<HTMLElement>) => void;
	onPointerMove: (event: PointerEvent<HTMLElement>) => void;
	onPointerUp: () => void;
	onPointerCancel: () => void;
	onClickCapture: (event: MouseEvent<HTMLElement>) => void;
	onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}

export const useMenuPress = (onMenu: (spot: Spot) => void): MenuPressHandlers => {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const start = useRef<Spot | null>(null);
	const firedAt = useRef<number | null>(null);

	const clear = () => {
		if (timer.current) {
			clearTimeout(timer.current);
			timer.current = null;
		}
	};

	useEffect(() => clear, []);

	return {
		onPointerDown: (event) => {
			if (event.pointerType !== 'touch') {
				return;
			}

			const spot = { x: event.clientX, y: event.clientY };

			clear();
			firedAt.current = null;
			start.current = spot;
			timer.current = setTimeout(() => {
				firedAt.current = Date.now();
				onMenu(spot);
			}, LONG_PRESS_MS);
		},
		onPointerMove: (event) => {
			const from = start.current;

			if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > MOVE_TOLERANCE_PX) {
				clear();
			}
		},
		onPointerUp: clear,
		onPointerCancel: clear,
		onClickCapture: (event) => {
			if (firedAt.current !== null) {
				firedAt.current = null;
				event.preventDefault();
				event.stopPropagation();
			}
		},
		onContextMenu: (event) => {
			event.preventDefault();

			if (firedAt.current !== null && Date.now() - firedAt.current < NATIVE_MENU_AFTER_MS) {
				return;
			}

			onMenu(
				readMenuSpot(
					{ x: event.clientX, y: event.clientY },
					event.currentTarget.getBoundingClientRect(),
				),
			);
		},
	};
};
