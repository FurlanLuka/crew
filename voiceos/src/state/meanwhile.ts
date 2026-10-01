// The waiting updates in state: the page counts them, "what did I miss?" and the quiet play them.
import {
	isSwitchOfferFresh,
	type Input,
	type MeanwhileItem,
	type State,
	type ToldAsk,
} from '../shared/protocol.js';
import {
	describeMeanwhile,
	listNamedItems,
	listNamedRefs,
	type SaidItem,
} from '../speech/meanwhile.js';
import { describeAskForMeanwhile } from './asks.js';
import { readScreenRef, sayRef, withoutEffects } from './helpers.js';
import type { ReducerResult } from './reducer.js';
import { isActive } from '../shared/active.js';

type MeanwhileAdded = Extract<Input, { type: 'meanwhile_added' }>;

// A session's newer update replaces its older one: the line says where each session is now.
// An inactive session waits for nothing: a late event from one just deactivated adds no update.
export const addMeanwhile = (state: State, input: MeanwhileAdded, at: number): State => {
	if (!state.sessions[input.ref] || !isActive(state, input.ref)) {
		return state;
	}

	const item: MeanwhileItem = {
		ref: input.ref,
		kind: input.kind,
		about: input.about,
		at,
		...(input.askId ? { askId: input.askId } : {}),
	};
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

// An ask is said as it stands when the line plays: one answered or closed meanwhile is left out, and
// one that moved on to its next question says that one.
const readSaidItems = (state: State, items: MeanwhileItem[]): SaidItem[] =>
	items.flatMap((item) => {
		if (item.askId === undefined) {
			return [item];
		}

		const ask = state.asks.find((pending) => pending.id === item.askId);

		if (!ask) {
			return [];
		}

		const { phrase, isTold } = describeAskForMeanwhile(ask);

		return [{ ...item, phrase, ...(isTold ? { isTold: true as const } : {}) }];
	});

interface IsSwitchOfferedParams {
	state: State;
	items: SaidItem[];
	toldAsks: ToldAsk[];
	at: number;
}

// One session's update, and nothing it asked in full: the line offers to go there, the way an
// answer from that session now reaches the developer. Several sessions: which one would a yes mean?
// A question said in full is answered where they are, and an offer still open is not asked over.
const isSwitchOffered = ({ state, items, toldAsks, at }: IsSwitchOfferedParams): boolean =>
	items.length === 1 && toldAsks.length === 0 && !isSwitchOfferFresh(state.switchOffer, at);

export const playMeanwhile = (state: State, at: number): ReducerResult => {
	// The session on screen says its own updates.
	const screenRef = readScreenRef(state);
	const items = readSaidItems(
		state,
		state.meanwhile.filter((item) => item.ref !== screenRef),
	);

	if (items.length === 0) {
		return withoutEffects({ ...state, meanwhile: [] });
	}

	const text = describeMeanwhile({
		items,
		nameOf: (ref) => sayRef(state, ref),
	});
	// Only what the line says by name is told: an ask it only counts was not heard.
	const toldAsks: ToldAsk[] = listNamedItems(items).flatMap((item) =>
		item.isTold && item.askId ? [{ ref: item.ref, askId: item.askId }] : [],
	);
	const hasAsk = items.some((item) => item.askId !== undefined);
	const offeredRef = isSwitchOffered({ state, items, toldAsks, at }) ? items[0]?.ref : undefined;

	return {
		state: {
			...state,
			meanwhile: [],
			...(offeredRef ? { switchOffer: { ref: offeredRef, at } } : {}),
		},
		effects: [
			{
				type: 'speak',
				text: offeredRef ? `${text} Switch there?` : text,
				source: 'narrator',
				priority: 'normal',
				isOwed: true,
				isUpdate: true,
				refs: listNamedRefs(items),
				...(toldAsks.length > 0 ? { toldAsks, isAsking: true } : {}),
				...(offeredRef ? { ref: offeredRef, isAsking: true } : {}),
				...(hasAsk ? { chime: 'needs' as const } : {}),
			},
		],
	};
};
