// "For checkout?": words right after checkout's notification that could be a reply to it or for the
// session on screen. Voice OS asks once; yes sends them there, no or silence keeps them on the screen.
import type { Input, Stamped, State } from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { sayAck, sayRef } from './helpers.js';
import type { ReducerResult } from './reducer.js';

const log = createLogger('target-ask');

type TargetInput = Extract<Input, { type: 'ask_target' | 'settle_target' }>;

export const isTargetInput = (input: Input): input is TargetInput =>
	input.type === 'ask_target' || input.type === 'settle_target';

export const reduceTargetAsk = (
	state: State,
	input: TargetInput,
	stamped: Stamped,
): ReducerResult => {
	if (input.type === 'ask_target') {
		if (!state.sessions[input.ref] || !state.sessions[input.screen]) {
			return { state, effects: [] };
		}

		log.info('asked which session', { ref: input.ref, screen: input.screen });

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

	log.info('which session settled', { ref: ask.ref, toTarget: input.toTarget });

	// Where the words go is sent by whoever settled it (the router or the lapse): the send says it.
	if (input.toTarget) {
		return { state: { ...state, targetAsk: null }, effects: [] };
	}

	// Kept on the screen: "Kept on crew" already says where the words went, and a conversation
	// elsewhere ends with it.
	return {
		state: { ...state, targetAsk: null, exchange: null },
		effects: [sayAck(`Kept on ${sayRef(state, ask.screen)}.`, { ref: ask.screen })],
	};
};
