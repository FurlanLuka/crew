// The installed app's back swipe: a touch from the left edge drags the screen with the finger, and
// letting go far or fast enough goes back. Listeners sit on the stable root and move whichever screen
// is current, so a screen that remounts on every view change needs no wiring of its own. Moves write
// the transform directly: a render per touchmove would stutter.
import { type RefObject, useEffect, useRef } from 'react';
import { decideSwipeEnd, decideSwipeStart, EDGE_PX } from './phone-nav.js';

const SCREEN = ':scope > .ph-screen';
const UNDER = ':scope > .ph-under';
// Where the uncovered screen starts, as iOS sets it back: a little to the left and dimmed. The same
// as .ph-under's resting transform and filter in phone.css; change both together.
const UNDER_SHIFT_PERCENT = -24;
const UNDER_DIM = 0.6;
const SETTLE_MS = 200;
// A back the server applies: the screen waits off to the side for the new view, and only comes back
// if none arrived (the connection dropped), never in the round trip's meantime.
const LAND_MS = 1500;

// What a back did: closed something on this screen, or asked the server for the screen above.
export type BackResult = 'here' | 'sent';

interface SwipeBackParams {
	rootRef: RefObject<HTMLElement | null>;
	isEnabled: boolean;
	onBack: () => BackResult;
	// The screen being uncovered is drawn only while a swipe shows it.
	onPeek: (isPeeking: boolean) => void;
}

interface Track {
	screen: HTMLElement;
	startX: number;
	startY: number;
	lastX: number;
	lastAt: number;
	velocity: number;
	phase: 'wait' | 'track';
}

const place = (screen: HTMLElement, x: number, isAnimated: boolean) => {
	screen.style.transition = isAnimated
		? `transform ${SETTLE_MS}ms cubic-bezier(.2,.8,.2,1)`
		: 'none';
	screen.style.transform = x === 0 ? '' : `translateX(${x}px)`;
};

// The screen underneath follows the finger: from set back and dimmed to in place as progress goes
// 0 → 1. It renders a frame after the swipe starts, so each move looks it up.
const placeUnder = (root: HTMLElement, progress: number, isAnimated: boolean) => {
	const under = root.querySelector<HTMLElement>(UNDER);

	if (!under) {
		return;
	}

	under.style.transition = isAnimated
		? `transform ${SETTLE_MS}ms cubic-bezier(.2,.8,.2,1), filter ${SETTLE_MS}ms`
		: 'none';
	under.style.transform = `translateX(${UNDER_SHIFT_PERCENT * (1 - progress)}%)`;
	under.style.filter = `brightness(${UNDER_DIM + (1 - UNDER_DIM) * progress})`;
};

export const useSwipeBack = ({ rootRef, isEnabled, onBack, onPeek }: SwipeBackParams): void => {
	// The state changes many times a second; a swipe in progress must outlive those renders.
	const onBackRef = useRef(onBack);
	onBackRef.current = onBack;
	const onPeekRef = useRef(onPeek);
	onPeekRef.current = onPeek;

	useEffect(() => {
		const root = rootRef.current;

		if (!root || !isEnabled) {
			return;
		}

		let track: Track | null = null;

		const handleStart = (event: TouchEvent) => {
			const touch = event.touches[0];
			const screen = root.querySelector<HTMLElement>(SCREEN);
			const target = event.target instanceof Element ? event.target : null;

			// A full-screen dialog or a second finger is never a back swipe.
			if (!touch || !screen || event.touches.length > 1 || target?.closest('dialog')) {
				track = null;

				return;
			}

			track =
				touch.clientX <= EDGE_PX
					? {
							screen,
							startX: touch.clientX,
							startY: touch.clientY,
							lastX: touch.clientX,
							lastAt: event.timeStamp,
							velocity: 0,
							phase: 'wait',
						}
					: null;
		};

		const handleMove = (event: TouchEvent) => {
			const touch = event.touches[0];

			if (!track || !touch) {
				return;
			}

			const dx = touch.clientX - track.startX;
			const dy = touch.clientY - track.startY;

			if (track.phase === 'wait') {
				const verdict = decideSwipeStart({ dx, dy });

				if (verdict === 'scroll') {
					track = null;

					return;
				}

				if (verdict === 'wait') {
					return;
				}

				track.phase = 'track';
				root.classList.add('swiping');
				onPeekRef.current(true);
			}

			// The finger owns the screen now: no scroll underneath, no rubber band.
			event.preventDefault();
			const elapsed = Math.max(1, event.timeStamp - track.lastAt);
			track.velocity = (touch.clientX - track.lastX) / elapsed;
			track.lastX = touch.clientX;
			track.lastAt = event.timeStamp;
			place(track.screen, Math.max(0, dx), false);
			placeUnder(root, Math.max(0, dx) / root.clientWidth, false);
		};

		// A cancelled touch (the system took the gesture) never goes back: the screen springs home.
		const handleEnd = (event: TouchEvent) => {
			if (!track || track.phase !== 'track') {
				track = null;

				return;
			}

			const { screen, velocity } = track;
			const dx = Math.max(0, track.lastX - track.startX);
			const width = root.clientWidth;
			track = null;

			if (event.type === 'touchcancel' || decideSwipeEnd({ dx, velocity, width }) === 'cancel') {
				place(screen, 0, true);
				placeUnder(root, 0, true);
				setTimeout(() => {
					root.classList.remove('swiping');
					onPeekRef.current(false);
				}, SETTLE_MS);

				return;
			}

			place(screen, width, true);
			placeUnder(root, 1, true);
			setTimeout(() => {
				const result = onBackRef.current();
				root.classList.remove('swiping');
				onPeekRef.current(false);
				// A back that keeps this screen (⋯ closing) must not leave it off to the side.
				setTimeout(
					() => {
						if (screen.isConnected) {
							place(screen, 0, false);
						}
					},
					result === 'here' ? 0 : LAND_MS,
				);
			}, SETTLE_MS);
		};

		root.addEventListener('touchstart', handleStart, { passive: true });
		root.addEventListener('touchmove', handleMove, { passive: false });
		root.addEventListener('touchend', handleEnd);
		root.addEventListener('touchcancel', handleEnd);

		return () => {
			// Torn down mid-swipe (the view changed under the finger): nothing may stay uncovered.
			if (track?.phase === 'track') {
				root.classList.remove('swiping');
				onPeekRef.current(false);
			}

			root.removeEventListener('touchstart', handleStart);
			root.removeEventListener('touchmove', handleMove);
			root.removeEventListener('touchend', handleEnd);
			root.removeEventListener('touchcancel', handleEnd);
		};
	}, [rootRef, isEnabled]);
};
