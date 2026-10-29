// Which way the screen that just came in slides: decided once per change of screen, during render,
// so the new screen mounts with its animation already on. A back swipe has already moved the screen
// away and shown the one under it: that change does not slide again.
import { type RefObject, useRef } from 'react';
import type { View } from '../shared/protocol.js';
import { readTransition, readViewKey, type Transition } from './phone-nav.js';

export const usePhoneTransition = (view: View, isSwiped: RefObject<boolean>): Transition => {
	const previous = useRef(view);
	const transition = useRef<Transition>(null);

	if (readViewKey(previous.current) !== readViewKey(view)) {
		transition.current = isSwiped.current ? null : readTransition(previous.current, view);
		isSwiped.current = false;
		previous.current = view;
	}

	return transition.current;
};
