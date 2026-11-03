// The phone page fits what is visible when the keyboard is up: iOS shrinks only the visual viewport
// then and pans it down to show the focused field, which left the box near the top of what is seen
// and the app's top bar above it. With the keyboard up the page follows the visual viewport (its
// height --vvh and where it starts --vvt), so the box sits right on the keyboard; the window is put
// back at the top, so only each screen's own list ever scrolls.
import { useEffect } from 'react';
import { clientLog } from './client-log.js';

// The visible part this much smaller than the page: a keyboard is up, not just the toolbar moving.
const KEYBOARD_SHARE = 0.8;

export const isKeyboardUp = (visibleHeight: number, pageHeight: number): boolean =>
	visibleHeight < pageHeight * KEYBOARD_SHARE;

// Where the page and its bar sit against the screen: what the log needs when the bar is not at the
// bottom on a phone nobody can open devtools on.
export const logViewport = (why: string): void => {
	const page = document.querySelector('.vo.phone')?.getBoundingClientRect();
	const bar = document.querySelector('.phone-bar')?.getBoundingClientRect();

	clientLog('info', 'viewport', why, {
		innerHeight: window.innerHeight,
		visibleHeight: Math.round(window.visualViewport?.height ?? 0),
		visibleTop: Math.round(window.visualViewport?.offsetTop ?? 0),
		screenHeight: window.screen.height,
		pageBottom: Math.round(page?.bottom ?? 0),
		barBottom: Math.round(bar?.bottom ?? 0),
		scrollY: window.scrollY,
		isKeyboard: document.documentElement.hasAttribute('data-keyboard'),
	});
};

export const usePhoneViewport = (viewKey: string): void => {
	useEffect(() => {
		const viewport = window.visualViewport;

		if (!viewport) {
			return;
		}

		const root = document.documentElement;

		// Only while the keyboard is up: at rest the page is pinned to the screen's edges (phone.css). Sized to the
		// visual viewport at load, an installed app could come out a little short before iOS settled
		// its bars, and the box sat above the bottom until something resized.
		const fit = () => {
			const isUp = isKeyboardUp(viewport.height, window.innerHeight);
			const wasUp = root.hasAttribute('data-keyboard');

			root.toggleAttribute('data-keyboard', isUp);

			if (isUp) {
				root.style.setProperty('--vvh', `${Math.round(viewport.height)}px`);
				root.style.setProperty('--vvt', `${Math.round(viewport.offsetTop)}px`);
			} else {
				root.style.removeProperty('--vvh');
				root.style.removeProperty('--vvt');
			}

			if (window.scrollY !== 0) {
				window.scrollTo(0, 0);
			}

			if (isUp !== wasUp) {
				logViewport(isUp ? 'keyboard up' : 'keyboard down');
			}
		};

		fit();
		logViewport('opened');
		viewport.addEventListener('resize', fit);
		viewport.addEventListener('scroll', fit);

		return () => {
			viewport.removeEventListener('resize', fit);
			viewport.removeEventListener('scroll', fit);
			root.style.removeProperty('--vvh');
			root.style.removeProperty('--vvt');
			root.removeAttribute('data-keyboard');
		};
	}, []);

	// After the new screen has laid out: where the bar ended up.
	useEffect(() => {
		const frame = requestAnimationFrame(() => logViewport(`screen ${viewKey}`));

		return () => cancelAnimationFrame(frame);
	}, [viewKey]);
};
