// How the phone moves between screens, as a native app does: how deep a screen is, which way a
// change of screen slides, and whether a swipe from the left edge goes back.
import { parentView } from '../shared/machines.js';
import type { State, View } from '../shared/protocol.js';

// Home is the root; Settings and a machine's page one level in; a session one deeper when it was
// opened from a machine's page (back returns there), else one.
export const readDepth = (view: View): number => {
	switch (view.kind) {
		case 'active':
			return 0;
		case 'session':
			return view.from === 'active' ? 1 : 2;
		default:
			return 1;
	}
};

export const readViewKey = (view: View): string =>
	view.kind === 'session'
		? `session:${view.ref}`
		: view.kind === 'activate'
			? `activate:${view.machine ?? ''}`
			: view.kind;

export type Transition = 'push' | 'pop' | null;

// Deeper slides in from the right, back from the left; a sideways move (one session to another) just
// shows, as a tab change does.
export const readTransition = (previous: View, next: View): Transition => {
	if (readViewKey(previous) === readViewKey(next)) {
		return null;
	}

	const from = readDepth(previous);
	const to = readDepth(next);

	return to > from ? 'push' : to < from ? 'pop' : null;
};

// The screen one level up: what the top bar's back, the edge swipe and the phone's back gesture all
// go to.
export const readBackView = (state: State): View | null =>
	readDepth(state.view) === 0 ? null : parentView(state);

// Only a touch that starts at the very edge can be a back swipe; inside, it scrolls or taps.
export const EDGE_PX = 24;

interface SwipeMove {
	dx: number;
	dy: number;
}

// Mostly sideways and to the right: the screen follows the finger. Mostly vertical: a scroll, left
// alone for good.
export const decideSwipeStart = ({ dx, dy }: SwipeMove): 'track' | 'scroll' | 'wait' => {
	if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
		return 'wait';
	}

	return dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.2 ? 'track' : 'scroll';
};

interface SwipeEnd {
	dx: number;
	// px per ms at the moment of letting go.
	velocity: number;
	width: number;
}

// Past a third of the screen, or flicked: back. Otherwise the screen springs home.
export const decideSwipeEnd = ({ dx, velocity, width }: SwipeEnd): 'back' | 'cancel' =>
	dx > width / 3 || (velocity > 0.5 && dx > 30) ? 'back' : 'cancel';
