// The waiting updates in state: the page counts them, "what did I miss?" and the quiet play them.
import type { Input, MeanwhileItem, State } from '../shared/protocol.js';
import { describeMeanwhile } from '../speech/meanwhile.js';
import { readAnnouncedLabel } from './held-lines.js';
import { sayRef, withoutEffects } from './helpers.js';
import type { ReducerResult } from './reducer.js';

type MeanwhileAdded = Extract<Input, { type: 'meanwhile_added' }>;

// A session's newer update replaces its older one: the line says where each session is now.
export const addMeanwhile = (state: State, input: MeanwhileAdded, at: number): State => {
	if (!state.sessions[input.ref]) {
		return state;
	}

	const item: MeanwhileItem = { ref: input.ref, kind: input.kind, about: input.about, at };
	const kept = state.meanwhile.filter((waiting) => waiting.ref !== input.ref);
	const oldest = state.meanwhile.find((waiting) => waiting.ref === input.ref)?.at ?? at;

	// It keeps its place in the wait: a busy session never pushes its update back forever.
	return { ...state, meanwhile: [...kept, { ...item, at: Math.min(oldest, at) }] };
};

export const playMeanwhile = (state: State): ReducerResult => {
	if (state.meanwhile.length === 0) {
		return withoutEffects(state);
	}

	const text = describeMeanwhile({
		items: state.meanwhile,
		nameOf: (ref) => readAnnouncedLabel(state, ref, sayRef(state, ref)),
	});

	return {
		state: { ...state, meanwhile: [] },
		effects: [
			{
				type: 'speak',
				text,
				source: 'narrator',
				priority: 'normal',
				isOwed: true,
				isUpdate: true,
				refs: state.meanwhile.map((item) => item.ref),
			},
		],
	};
};
