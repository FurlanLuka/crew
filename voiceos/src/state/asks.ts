import {
	isSdkAsk,
	type Denial,
	type Input,
	type PendingAsk,
	type PermissionDecision,
	type SdkAsk,
	type Stamped,
	type State,
} from '../shared/protocol.js';
import type { AskResult, Effect, ReducerResult } from './reducer.js';
import { cancelCommand, describeCommandAloud, findCommandAsk } from './commands.js';
import { readLabel, sendNow, updateSession, withoutEffects } from './helpers.js';

const ASK_INPUTS = [
	'answer_permission',
	'answer_question',
	'answer_plan',
	'ask_opened',
	'ask_closed',
	'denied',
	'allow_denied',
	'dismiss_denial',
] as const;

type AskInput = Extract<Input, { type: (typeof ASK_INPUTS)[number] }>;

const ASK_INPUT_SET = new Set<string>(ASK_INPUTS);

const MAX_SUMMARY_WORDS = 15;
const MAX_QUESTION_WORDS = 25;
const DENIALS_KEPT = 20;

type QuestionAsk = Extract<PendingAsk, { kind: 'question' }>;

export interface OpenQuestion {
	question: QuestionAsk['questions'][number];
	index: number;
}

export const findOpenQuestion = (ask: QuestionAsk): OpenQuestion | null => {
	// Answered one at a time, like the page: the first without an answer is the one asked now.
	const answers = ask.answers ?? {};
	const index = ask.questions.findIndex((entry) => !(entry.question in answers));
	const question = ask.questions[index];

	return question ? { question, index } : null;
};

export const completesAsk = (ask: PendingAsk): boolean => {
	// Words for an ask reach the session only once they settle it: one open question or none left.
	if (ask.kind !== 'question') {
		return true;
	}

	const answers = ask.answers ?? {};

	return ask.questions.filter((entry) => !(entry.question in answers)).length <= 1;
};

export const isAskInput = (input: Input): input is AskInput => ASK_INPUT_SET.has(input.type);

export const closeAsk = (state: State, askId: string): State => {
	const ask = state.asks.find((pendingAsk) => pendingAsk.id === askId);

	if (!ask) {
		return state;
	}

	const asks = state.asks.filter((pendingAsk) => pendingAsk.id !== askId);
	// A held command never blocks the turn: only the SDK's own asks do.
	const isStillBlocked = asks.some(
		(pendingAsk) => pendingAsk.ref === ask.ref && isSdkAsk(pendingAsk),
	);

	return updateSession({ ...state, asks }, ask.ref, (session) =>
		session.status === 'blocked' && !isStillBlocked ? { ...session, status: 'running' } : session,
	);
};

export const settleAsksForSession = (state: State, ref: string, message: string): ReducerResult => {
	// Stopping or interrupting a session denies all its asks at once; only the reducer settles them.
	// A held command has no SDK side to answer: it only closes.
	const effects: Effect[] = state.asks
		.filter((ask) => ask.ref === ref && isSdkAsk(ask))
		.map((ask) => ({ type: 'resolve_ask', askId: ask.id, result: { behavior: 'deny', message } }));

	return { state: { ...state, asks: state.asks.filter((ask) => ask.ref !== ref) }, effects };
};

export const buildPermissionResult = (
	ask: SdkAsk,
	decision: PermissionDecision,
	message?: string,
): AskResult => {
	if (decision === 'deny') {
		return { behavior: 'deny', message: message?.trim() || 'The user declined this.' };
	}

	const shouldRemember =
		decision === 'always' && ask.kind === 'permission' && ask.suggestions.length > 0;

	return {
		behavior: 'allow',
		updatedInput: ask.input,
		...(shouldRemember ? { updatedPermissions: ask.suggestions } : {}),
	};
};

const capWords = (text: string, maxWords: number): string => {
	const words = text.trim().split(/\s+/);

	return words.length > maxWords ? `${words.slice(0, maxWords).join(' ')}…` : words.join(' ');
};

export const describeAskAloud = (ask: PendingAsk, label: string): string => {
	// Kept short: the developer did not ask for it.
	switch (ask.kind) {
		case 'permission': {
			const summary = capWords(ask.summary, MAX_SUMMARY_WORDS);

			return `${label} wants to ${summary}${summary.endsWith('…') ? '' : '.'} Allow?`;
		}
		case 'plan':
			return `${label} has a plan ready for approval.`;
		case 'command':
			return describeCommandAloud(ask.command, label);
		case 'question':
			return describeQuestionAloud(ask, label);
	}
};

const describeQuestionAloud = (ask: QuestionAsk, label: string): string => {
	const open = findOpenQuestion(ask);

	if (!open) {
		return `${label} has a question.`;
	}

	// Options are read only on request, so the developer can answer in their own words first.
	const question = capWords(open.question.question, MAX_QUESTION_WORDS);
	const prompt = open.question.options.length > 0 ? ' Answer it, or say "options".' : '';
	const count = ask.questions.length;

	if (count === 1) {
		return `${label} asks: ${question}${prompt}`;
	}

	return open.index === 0
		? `${label} asks ${count} questions. First: ${question}${prompt}`
		: `${label}, question ${open.index + 1} of ${count}: ${question}${prompt}`;
};

const resolveAsk = (state: State, ask: PendingAsk, result: AskResult): ReducerResult => ({
	state: closeAsk(state, ask.id),
	effects: [{ type: 'resolve_ask', askId: ask.id, result }],
});

const findAsk = <Kind extends PendingAsk['kind']>(
	state: State,
	askId: string,
	kind: Kind,
): Extract<PendingAsk, { kind: Kind }> | null => {
	const ask = state.asks.find((pendingAsk) => pendingAsk.id === askId);

	return ask?.kind === kind ? (ask as Extract<PendingAsk, { kind: Kind }>) : null;
};

const allowDenied = (state: State, denialId: string, stamped: Stamped): ReducerResult => {
	const denial = state.denials.find((entry) => entry.id === denialId);
	const session = denial ? state.sessions[denial.ref] : undefined;

	if (!denial || !session) {
		return withoutEffects(state);
	}

	const retryText = `The user allows this once: retry "${denial.summary}". It will now ask for approval instead of being blocked.`;
	const setModeEffect: Effect = { type: 'worker_set_mode', ref: denial.ref, mode: 'default' };
	const cleared = updateSession(
		{ ...state, denials: state.denials.filter((entry) => entry.id !== denial.id) },
		denial.ref,
		(deniedSession) => ({ ...deniedSession, modeOverride: 'default-once' }),
	);

	if (session.status === 'idle') {
		const sent = sendNow({
			state: cleared,
			ref: denial.ref,
			text: retryText,
			itemId: stamped.id,
			at: stamped.at,
		});

		return { state: sent.state, effects: [setModeEffect, ...sent.effects] };
	}

	const queued = updateSession(cleared, denial.ref, (deniedSession) => ({
		...deniedSession,
		queue: [...deniedSession.queue, { id: stamped.id, text: retryText, at: stamped.at }],
	}));

	return { state: queued, effects: [setModeEffect] };
};

interface AnswerInWordsParams {
	state: State;
	ask: SdkAsk;
	text: string;
	stamped: Stamped;
}

export const answerInWords = ({
	state,
	ask,
	text,
	stamped,
}: AnswerInWordsParams): ReducerResult => {
	// The turn is blocked on the ask, so words queued behind it would never be read: they answer it.
	switch (ask.kind) {
		case 'question': {
			const open = findOpenQuestion(ask);

			if (!open) {
				return withoutEffects(state);
			}

			return reduceAsk(
				state,
				{
					type: 'answer_question',
					askId: ask.id,
					answers: { [open.question.question]: text },
					isSpoken: true,
				},
				stamped,
			);
		}

		case 'plan':
			return reduceAsk(
				state,
				{ type: 'answer_plan', askId: ask.id, isApproved: false, message: text },
				stamped,
			);
		case 'permission':
			return reduceAsk(
				state,
				{ type: 'answer_permission', askId: ask.id, decision: 'deny', message: text },
				stamped,
			);
	}
};

export const reduceAsk = (state: State, input: AskInput, stamped: Stamped): ReducerResult => {
	switch (input.type) {
		case 'answer_permission': {
			const ask = findAsk(state, input.askId, 'permission');

			return ask
				? resolveAsk(state, ask, buildPermissionResult(ask, input.decision, input.message))
				: withoutEffects(state);
		}

		case 'answer_question': {
			const ask = findAsk(state, input.askId, 'question');

			if (!ask) {
				return withoutEffects(state);
			}

			// Only answers to this ask's own questions count: nothing is filed under a question it lacks.
			const asked = new Set(ask.questions.map((entry) => entry.question));
			const answers = {
				...ask.answers,
				...Object.fromEntries(
					Object.entries(input.answers).filter(([question]) => asked.has(question)),
				),
			};
			const answered = { ...ask, answers };

			if (!findOpenQuestion(answered)) {
				return resolveAsk(state, ask, {
					behavior: 'allow',
					updatedInput: { ...ask.input, answers },
				});
			}

			const next = {
				...state,
				asks: state.asks.map((pendingAsk) => (pendingAsk.id === ask.id ? answered : pendingAsk)),
			};

			// Said aloud only after a spoken answer: a click moves the page on by itself.
			return input.isSpoken
				? {
						state: next,
						effects: [
							{
								type: 'speak',
								text: describeAskAloud(answered, readLabel(state, ask.ref)),
								source: 'alert',
								ref: ask.ref,
								isAsking: true,
							},
						],
					}
				: withoutEffects(next);
		}

		case 'answer_plan': {
			const ask = findAsk(state, input.askId, 'plan');

			if (!ask) {
				return withoutEffects(state);
			}

			const result: AskResult = input.isApproved
				? { behavior: 'allow', updatedInput: ask.input }
				: {
						behavior: 'deny',
						message:
							input.message?.trim() || 'The user wants changes to the plan before you start.',
					};

			return resolveAsk(state, ask, result);
		}

		case 'ask_opened': {
			const { ask } = input;

			if (!state.sessions[ask.ref] || state.asks.some((pendingAsk) => pendingAsk.id === ask.id)) {
				return withoutEffects(state);
			}

			// A "yes" said next would be meant for this ask: a /clear still held must not take it.
			const heldCommand = findCommandAsk(state, ask.ref);
			const cleared = heldCommand ? cancelCommand({ state, ask: heldCommand, stamped }) : state;
			const next = updateSession(
				{ ...cleared, asks: [...cleared.asks, ask] },
				ask.ref,
				(session) => ({
					...session,
					status: 'blocked',
				}),
			);

			return {
				state: next,
				effects: [
					{
						type: 'speak',
						text: describeAskAloud(ask, readLabel(state, ask.ref)),
						source: 'alert',
						ref: ask.ref,
						isAsking: true,
					},
				],
			};
		}

		case 'ask_closed':
			return withoutEffects(closeAsk(state, input.askId));

		case 'denied': {
			const denial: Denial = {
				id: stamped.id,
				ref: input.ref,
				toolName: input.toolName,
				summary: input.summary,
				at: stamped.at,
			};

			return {
				state: { ...state, denials: [...state.denials, denial].slice(-DENIALS_KEPT) },
				effects: [
					{
						type: 'speak',
						text: `Auto mode blocked ${readLabel(state, input.ref)}: ${input.summary}.`,
						source: 'alert',
						ref: input.ref,
					},
				],
			};
		}

		case 'allow_denied':
			return allowDenied(state, input.denialId, stamped);
		case 'dismiss_denial':
			return withoutEffects({
				...state,
				denials: state.denials.filter((denial) => denial.id !== input.denialId),
			});
	}
};
