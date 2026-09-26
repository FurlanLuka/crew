import type { Action, PendingAsk, State } from '../shared/protocol.js';
import { findOpenQuestion, hasOpenQuestionMoved } from '../shared/questions.js';
import { type ToolResult, checkRef, fail, succeed } from './results.js';
import { isConsent, isPlainConsent } from './consent.js';
import { describeMisroutedAnswer, prepareSentText, sendText } from './send.js';
import { findLastAskedAloud } from './asked-aloud.js';
import { findSessionsNamedIn } from './session-naming.js';
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

		case 'command': {
			if (decision === 'choose') {
				return { ok: false, error: 'a /clear or /compact confirmation is answered yes or no' };
			}

			return {
				ok: true,
				actions: [{ type: 'answer_command', askId: ask.id, isApproved: decision !== 'no' }],
			};
		}

		case 'question': {
			// Several questions are answered one at a time: the words answer the one asked now.
			const question = findOpenQuestion(ask)?.question;

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
					{
						type: 'answer_question',
						askId: ask.id,
						answers: { [question.question]: answerValue },
						isSpoken: true,
					},
				],
			};
		}
	}
};

interface IsAnswerForParams {
	state: State;
	ref: string;
	toolContext: ToolContext;
}

const isClearlyAnswerFor = ({ state, ref, toolContext }: IsAnswerForParams): boolean => {
	// With several sessions waiting, a bare "yes" is only theirs when they named it, look at it,
	// or Voice OS just asked about it: approving the wrong push is the one mistake that cannot wait.
	const { utterance, asks } = toolContext;
	const isAlone = asks.every((ask) => ask.ref === ref);

	if (isAlone || utterance === undefined || toolContext.screen === ref) {
		return true;
	}

	const lastAskedAloud = findLastAskedAloud({
		spoken: state.spoken,
		waitingRefs: asks.map((ask) => ask.ref),
		now: toolContext.now(),
	});

	return lastAskedAloud?.ref === ref || findSessionsNamedIn(state, utterance).includes(ref);
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
		// The model reaches for answer when a session asked at the end of its turn: that reply is
		// words for the session, so it goes there instead of failing into a made-up explanation.
		const written = (typeof input.text === 'string' && input.text.trim()) || toolContext.utterance;
		const reply = written
			? prepareSentText({
					state,
					ref: checked.ref,
					text: written,
					utterance: toolContext.utterance,
					isOnlySend: (toolContext.actionsInTurn ?? 1) <= 1,
				})
			: written;

		if (state.sessions[checked.ref]?.needsUser && reply) {
			const misroutedAnswer = describeMisroutedAnswer(state, checked.ref, reply);

			if (misroutedAnswer) {
				return fail(misroutedAnswer);
			}

			const isOnScreen = toolContext.forwardTo === checked.ref;

			return {
				...sendText({ state, ref: checked.ref, text: reply, kind: 'instruction', toolContext }),
				recordAs: isOnScreen
					? { name: 'forward', input: { text: reply } }
					: { name: 'send_to', input: { ref: checked.ref, text: reply } },
			};
		}

		return fail(
			`${checked.ref} has nothing pending to answer: forward or send_to the words instead.`,
		);
	}

	const liveAsk = state.asks.find((ask) => ask.id === heardAsk.id);

	if (!liveAsk) {
		return fail(`${checked.ref}'s question was already settled; tell the developer.`);
	}

	if (hasOpenQuestionMoved(heardAsk, liveAsk)) {
		return fail(
			`not answered: that question already has an answer and ${checked.ref} now asks the next one. Tell the developer in a few words that their words were not used for it; do not read the next question (it is on the page, or Voice OS already read it).`,
		);
	}

	const decision = input.decision as AnswerDecision;

	if (!isClearlyAnswerFor({ state, ref: checked.ref, toolContext })) {
		return fail(
			'Not answered: several sessions are waiting and the developer did not say which. Ask which one, in a few words.',
		);
	}

	if (!ANSWER_DECISIONS.includes(decision)) {
		return fail(`decision must be one of ${ANSWER_DECISIONS.join(', ')}`);
	}

	// Approving a command or a plan is the one call that must never be guessed from other words.
	const isApproval = heardAsk.kind !== 'question' && (decision === 'yes' || decision === 'always');
	const hasConsented = heardAsk.kind === 'command' ? isPlainConsent : isConsent;

	if (isApproval && toolContext.utterance !== undefined && !hasConsented(toolContext.utterance)) {
		return fail(
			`not answered: the developer did not say yes. Their words are for ${checked.ref}: forward them as said (they decline its ${heardAsk.kind === 'command' ? `/${heardAsk.command}` : heardAsk.kind} and reach it).`,
		);
	}

	const answerResult = buildAnswerActions({
		ask: liveAsk,
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
