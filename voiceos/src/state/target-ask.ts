// "For checkout?": words that name checkout without clearly speaking to it ("make sure it's on top of
// the checkout branch") could be for it or for the session on screen. Voice OS asks once; yes sends
// them there, no or silence keeps them on the screen.
import type { Input, Stamped, State } from '../shared/protocol.js';
import { sayAck, sayRef } from './helpers.js';
import type { ReducerResult } from './reducer.js';

type TargetInput = Extract<Input, { type: 'ask_which' | 'settle_target' }>;

export const isTargetInput = (input: Input): input is TargetInput =>
	input.type === 'ask_which' || input.type === 'settle_target';

export const reduceTargetAsk = (
	state: State,
	input: TargetInput,
	stamped: Stamped,
): ReducerResult => {
	if (input.type === 'ask_which') {
		if (!state.sessions[input.ref] || !state.sessions[input.screen]) {
			return { state, effects: [] };
		}

		return {
			state: {
				...state,
				targetAsk: { ref: input.ref, screen: input.screen, text: input.text, at: stamped.at },
			},
			effects: [
				sayAck(`For ${sayRef(state, input.ref)}?`, {
					ref: input.ref,
					isAck: false,
					isAsking: true,
				}),
			],
		};
	}

	const ask = state.targetAsk;

	if (!ask || ask.at !== input.at) {
		return { state, effects: [] };
	}

	// Where the words go is sent by whoever settled it (the router or the lapse): the send says it.
	if (input.toTarget) {
		return { state: { ...state, targetAsk: null }, effects: [] };
	}

	// Kept on the screen: "Kept on crew" says where the words went.
	return {
		state: { ...state, targetAsk: null },
		effects: [sayAck(`Kept on ${sayRef(state, ask.screen)}.`, { ref: ask.screen })],
	};
};
