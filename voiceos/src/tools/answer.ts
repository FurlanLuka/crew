import type { Action, PendingAsk, State } from '../shared/protocol.js';
import { ON_SCREEN_MESSAGE } from '../state/asks.js';
import { type ToolResult, checkRef, fail, succeed } from './results.js';
import type { ToolContext } from './tools.js';

export const ANSWER_DECISIONS = ['yes', 'always', 'no', 'choose'] as const;
export type AnswerDecision = (typeof ANSWER_DECISIONS)[number];

export interface BuildAnswerActionsParams {
	ask: PendingAsk;
	decision: AnswerDecision;
	text: string;
}

type AnswerActionsResult = { ok: true; actions: Action[] } | { ok: false; error: string };

export const buildAnswerActions = ({
	ask,
	decision,
	text,
}: BuildAnswerActionsParams): AnswerActionsResult => {
	const addedWords = text.trim();
	// Words added to a yes follow as a message, so they reach the session instead of being dropped.
	const followUpActions: Action[] = addedWords
		? [{ type: 'send', ref: ask.ref, text: addedWords }]
		: [];

	switch (ask.kind) {
		case 'permission': {
			if (decision === 'choose') {
				return { ok: false, error: 'a permission is answered yes, always or no' };
			}

			const verdict = decision === 'no' ? 'deny' : decision === 'always' ? 'always' : 'allow';

			if (verdict === 'deny') {
				return {
					ok: true,
					actions: [
						{
							type: 'answer_permission',
							askId: ask.id,
							decision: verdict,
							...(addedWords ? { message: addedWords } : {}),
						},
					],
				};
			}

			return {
				ok: true,
				actions: [
					{ type: 'answer_permission', askId: ask.id, decision: verdict },
					...followUpActions,
				],
			};
		}

		case 'plan': {
			if (decision === 'choose') {
				return { ok: false, error: 'a plan is answered yes or no' };
			}

			const isApproved = decision !== 'no';

			if (!isApproved) {
				return {
					ok: true,
					actions: [
						{
							type: 'answer_plan',
							askId: ask.id,
							isApproved,
							...(addedWords ? { message: addedWords } : {}),
						},
					],
				};
			}

			return {
				ok: true,
				actions: [{ type: 'answer_plan', askId: ask.id, isApproved }, ...followUpActions],
			};
		}

		case 'question': {
			// Several questions cannot be answered in one breath.
			if (ask.questions.length > 1) {
				return { ok: false, error: `${ON_SCREEN_MESSAGE} Tell the developer so.` };
			}

			const question = ask.questions[0];

			if (!question) {
				return { ok: false, error: 'the question is empty' };
			}

			if (decision === 'choose' && !addedWords) {
				return { ok: false, error: "choose needs the option label or the developer's words" };
			}

			const answerValue = addedWords || (decision === 'no' ? 'No' : 'Yes');

			return {
				ok: true,
				actions: [
					{ type: 'answer_question', askId: ask.id, answers: { [question.question]: answerValue } },
				],
			};
		}
	}
};

export interface AnswerAskParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
}

export const answerAsk = ({ state, input, toolContext }: AnswerAskParams): ToolResult => {
	const checked = checkRef(state, input.ref);

	if (!checked.ok) {
		return fail(checked.error);
	}

	const heardAsk = toolContext.asks.find((ask) => ask.ref === checked.ref);

	if (!heardAsk) {
		return fail(
			`${checked.ref} has nothing pending to answer: forward or send_to the words instead.`,
		);
	}

	if (!state.asks.some((ask) => ask.id === heardAsk.id)) {
		return fail(`${checked.ref}'s question was already settled; tell the developer.`);
	}

	const decision = input.decision as AnswerDecision;

	if (!ANSWER_DECISIONS.includes(decision)) {
		return fail(`decision must be one of ${ANSWER_DECISIONS.join(', ')}`);
	}

	const answerResult = buildAnswerActions({
		ask: heardAsk,
		decision,
		text: typeof input.text === 'string' ? input.text : '',
	});

	if (!answerResult.ok) {
		return fail(answerResult.error);
	}

	for (const action of answerResult.actions) {
		toolContext.dispatch(action);
	}

	return succeed(
		`answered ${checked.ref}${answerResult.actions.length > 1 ? ', and sent the rest of what the developer said' : ''}`,
	);
};
