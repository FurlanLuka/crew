// The waiting updates in state: the page counts them, "what did I miss?" and the quiet play them.
import type { Input, MeanwhileItem, State } from '../shared/protocol.js';
import { describeMeanwhile, listNamedRefs } from '../speech/meanwhile.js';
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

// The developer met this session's update another way (switched there, heard it, answered it, spoke
// to it): the meanwhile line would say it again.
export const dropMeanwhileFor = (state: State, ref: string): State =>
	state.meanwhile.some((item) => item.ref === ref)
		? { ...state, meanwhile: state.meanwhile.filter((item) => item.ref !== ref) }
		: state;

const ANSWERS = new Set<Input['type']>([
	'answer_permission',
	'answer_question',
	'answer_plan',
	'answer_command',
]);

// Which session's waiting update an input settles, if any. Read against the state before it, where
// the ask being answered still is.
const readSettledRef = (before: State, after: State, input: Input): string | null => {
	switch (input.type) {
		case 'switch_view':
		case 'go_back':
			return after.view.kind === 'session' ? after.view.ref : null;
		case 'held_line_heard':
			return input.ref;
		case 'send':
			return input.isSpoken ? input.ref : null;
		default:
			return ANSWERS.has(input.type) && 'askId' in input
				? (before.asks.find((ask) => ask.id === input.askId)?.ref ?? null)
				: null;
	}
};

export const settleMeanwhile = (before: State, after: State, input: Input): State => {
	const ref = readSettledRef(before, after, input);

	return ref ? dropMeanwhileFor(after, ref) : after;
};

export const playMeanwhile = (state: State): ReducerResult => {
	// The session on screen says its own updates.
	const screenRef = state.view.kind === 'session' ? state.view.ref : null;
	const items = state.meanwhile.filter((item) => item.ref !== screenRef);

	if (items.length === 0) {
		return withoutEffects({ ...state, meanwhile: [] });
	}

	const text = describeMeanwhile({
		items,
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
				refs: listNamedRefs(items),
			},
		],
	};
};
