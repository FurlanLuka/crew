// "For checkout?": words right after checkout's notification that could be a reply to it or for the
// session on screen. Voice OS asks once; yes sends them there, no or silence keeps them on the screen.
import { TARGET_ASK_MS, type Input, type Stamped, type State } from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { sayRef } from './helpers.js';
import type { Effect, ReducerResult } from './reducer.js';

const log = createLogger('target-ask');

type TargetInput = Extract<Input, { type: 'ask_target' | 'settle_target' }>;

export const isTargetInput = (input: Input): input is TargetInput =>
	input.type === 'ask_target' || input.type === 'settle_target';

export const isTargetAskOpen = (state: State, now: number): boolean =>
	state.targetAsk !== null && now - state.targetAsk.at < TARGET_ASK_MS * 2;

const say = (text: string, ref: string, isAsking = false): Effect => ({
	type: 'speak',
	text,
	source: 'kernel',
	ref,
	isReply: true,
	priority: 'high',
	...(isAsking ? { isAsking: true } : { isAck: true }),
});

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
			effects: [say(`For ${sayRef(state, input.ref)}?`, input.ref, true)],
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
		effects: [say(`Kept on ${sayRef(state, ask.screen)}.`, ask.screen)],
	};
};
