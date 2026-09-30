import { isKnownMachineRef } from '../shared/machines.js';
import type { Input, State, View } from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { withoutEffects } from './helpers.js';

const PIN_INPUTS = ['pin_session', 'unpin_session', 'pinned_loaded'] as const;

type PinInput = Extract<Input, { type: (typeof PIN_INPUTS)[number] }>;

const PIN_INPUT_SET = new Set<string>(PIN_INPUTS);

export const isPinInput = (input: Input): input is PinInput => PIN_INPUT_SET.has(input.type);

export const isPinned = (state: State, ref: string): boolean => state.pinned.includes(ref);

// Pinned takes precedence: a pinned session opens inside Pinned from wherever it is opened, so its
// tabs are the pins and Esc goes back there; any other session opens in its machine.
export const toShownView = (state: State, view: View): View => {
	if (view.kind !== 'session') {
		return view;
	}

	return isPinned(state, view.ref)
		? { kind: 'session', ref: view.ref, from: 'pinned' }
		: { kind: 'session', ref: view.ref };
};

export const reducePin = (state: State, input: PinInput): ReducerResult => {
	switch (input.type) {
		case 'pin_session':
			// A pin names a session crew has; unpinning covers the one no longer there.
			return withoutEffects(
				isPinned(state, input.ref) || !state.sessions[input.ref]
					? state
					: { ...state, pinned: [...state.pinned, input.ref] },
			);

		case 'unpin_session':
			// The open session keeps its from: Esc still goes back to Pinned, where it no longer shows.
			return withoutEffects(
				isPinned(state, input.ref)
					? { ...state, pinned: state.pinned.filter((ref) => ref !== input.ref) }
					: state,
			);

		case 'pinned_loaded': {
			// The saved order first; a pin made before the file was read follows it.
			const pinned = [...new Set([...input.refs, ...state.pinned])].filter((ref) =>
				isKnownMachineRef(state, ref),
			);

			return withoutEffects({ ...state, pinned });
		}
	}
};
