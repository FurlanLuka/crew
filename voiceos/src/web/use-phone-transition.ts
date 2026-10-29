// Which way the screen that just came in slides: decided once per change of screen, during render,
// so the new screen mounts with its animation already on.
import { useRef } from 'react';
import type { View } from '../shared/protocol.js';
import { readTransition, readViewKey, type Transition } from './phone-nav.js';

export const usePhoneTransition = (view: View): Transition => {
	const previous = useRef(view);
	const transition = useRef<Transition>(null);

	if (readViewKey(previous.current) !== readViewKey(view)) {
		transition.current = readTransition(previous.current, view);
		previous.current = view;
	}

	return transition.current;
};
