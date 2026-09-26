import { readShownText } from '../shared/spoken-tags.js';
import type { Input, Session, Stamped, State, StreamItem } from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { deliverSend } from './delivery.js';
import { normalizeSaid, pushStreamItem, updateSession, withoutEffects } from './helpers.js';

type AsideSettledInput = Extract<Input, { type: 'aside_settled' }>;

export const QUEUED_ASIDE_LINE = 'It needs to look into that — queued for after its current work.';
export const FAILED_ASIDE_LINE = "Couldn't answer that aside — queued for after its current work.";
export const SENT_ASIDE_LINE = 'It needs to look into that — asked it now.';

export const isAsideInFlight = (session: Session, question: string): boolean => {
	// The same question asked again while its answer is on the way is heard once.
	const asked = normalizeSaid(question);

	return session.stream.some(
		(item) =>
			item.kind === 'aside' && item.status === 'asking' && normalizeSaid(item.question) === asked,
	);
};

interface StartAsideParams {
	state: State;
	ref: string;
	question: string;
	stamped: Stamped;
}

export const startAside = ({ state, ref, question, stamped }: StartAsideParams): ReducerResult => {
	const item: StreamItem = {
		id: stamped.id,
		at: stamped.at,
		kind: 'aside',
		question,
		answer: null,
		status: 'asking',
	};

	return {
		state: updateSession(state, ref, (session) => pushStreamItem(session, item)),
		effects: [{ type: 'side_answer', ref, itemId: stamped.id, question }],
	};
};

interface IsWithdrawnParams {
	state: State;
	ref: string;
	itemId: string;
}

const isWithdrawn = ({ state, ref, itemId }: IsWithdrawnParams): boolean =>
	state.sessions[ref]?.withdrawnAsides.includes(itemId) === true;

export const isAsideInput = (input: Input): input is AsideSettledInput =>
	input.type === 'aside_settled';

export const reduceAside = (
	state: State,
	input: AsideSettledInput,
	stamped: Stamped,
): ReducerResult => {
	const { question } = input;

	if (!state.sessions[input.ref]) {
		return withoutEffects(state);
	}

	// Replaced by the developer's continuation: never said, never queued.
	if (isWithdrawn({ state, ref: input.ref, itemId: input.itemId })) {
		return withoutEffects(state);
	}

	const settled = updateSession(state, input.ref, (current) => ({
		...current,
		stream: current.stream.map((item) =>
			item.id === input.itemId && item.kind === 'aside'
				? { ...item, status: input.status, answer: input.answer && readShownText(input.answer) }
				: item,
		),
	}));

	if (input.status === 'answered' && input.answer) {
		return {
			state: settled,
			effects: [{ type: 'narrate_aside', ref: input.ref, question, answer: input.answer }],
		};
	}

	// Its turn may have ended while the fork thought: then the question goes to it at once.
	const isIdle = state.sessions[input.ref]?.status === 'idle';
	const line = isIdle
		? SENT_ASIDE_LINE
		: input.status === 'failed'
			? FAILED_ASIDE_LINE
			: QUEUED_ASIDE_LINE;

	// Not answerable beside the work: it becomes work, queued like a typed message and never lost.
	// deliverSend, not reduceSend: a permission that opened meanwhile must not take it as its answer.
	const delivered = deliverSend({
		state: settled,
		ref: input.ref,
		text: question,
		isSpoken: false,
		stamped,
		shouldStart: false,
	});

	return {
		state: delivered.state,
		effects: [
			...delivered.effects,
			{
				type: 'speak',
				text: line,
				source: 'kernel',
				ref: input.ref,
				isNamed: true,
			},
		],
	};
};
