import type { Action, PendingAsk, State } from '../shared/protocol.js';
import { findOpenQuestion, hasOpenQuestionMoved, type QuestionAsk } from '../shared/questions.js';
import { type ToolResult, checkRef, fail, succeed } from './results.js';
import { isConsent, isPlainConsent } from './consent.js';
import {
	describeDebugNoteRequest,
	describeMisroutedAnswer,
	isBareAnswer,
	chooseSentWords,
	isWholeSend,
	recordAsSent,
	sendText,
} from './send.js';
import { findLastAskedAloud } from './asked-aloud.js';
import { findSessionsNamedIn } from './session-naming.js';
import type { ToolContext } from './tools.js';
import { refuseAnnouncedOnly } from './announced.js';
import { endsInQuestion } from '../shared/spoken.js';

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

		case 'redirect': {
			if (decision === 'choose') {
				return { ok: false, error: 'a switch is answered yes or no' };
			}

			// "Yes, and use staging" joins the instruction; "no, do X instead" is sent in its place.
			return {
				ok: true,
				actions: [
					{
						type: 'answer_redirect',
						askId: ask.id,
						isApproved: decision !== 'no',
						...(addedWords ? { message: addedWords } : {}),
					},
				],
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

const OPTION_FILLER_PATTERN =
	/^(?:(?:um|uh|so|and|maybe|the|option|number)\s+)+|\s+(?:one|option|please)$/g;
const ORDINALS = new Set([
	...['first', 'second', 'third', 'fourth', 'fifth', 'last'],
	...['one', 'two', 'three', 'four', 'five', '1', '2', '3', '4', '5'],
]);

const readBareOption = (said: string): string =>
	said
		.toLowerCase()
		.replace(/\([^)]*\)/g, ' ')
		.replace(/[?.!,"“”)\]]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(OPTION_FILLER_PATTERN, '');

const QUESTION_LEAD_PATTERN =
	/^(?:what|what's|whats|why|how|which|who|when|where|does|do|is|are|can|could|should|would|will)\b/;
// "Use Postgres?" for the label "Postgres", or "Postgres?" for "Use Postgres": a pick said with a
// few words around it. Longer, it is a sentence about the option ("what does Postgres do").
const MAX_PICK_EXTRA_WORDS = 2;

const countWords = (text: string): number => text.split(' ').filter(Boolean).length;

const hasPhrase = (text: string, phrase: string): boolean => ` ${text} `.includes(` ${phrase} `);

const isSpokenPick = (bare: string, labels: string[]): boolean => {
	// Exactly one label, even when another contains it ("Postgres" beside "Postgres + Redis") or it
	// opens like a question ("Do both").
	if (ORDINALS.has(bare) || labels.includes(bare)) {
		return true;
	}

	if (!bare || QUESTION_LEAD_PATTERN.test(bare)) {
		return false;
	}

	// Naming two options is weighing them, not choosing one.
	const named = labels.filter(
		(label) => label && (hasPhrase(bare, label) || hasPhrase(label, bare)),
	);

	return named.length === 1 && countWords(bare) <= countWords(named[0]!) + MAX_PICK_EXTRA_WORDS;
};

export const isClarifyingQuestion = (ask: QuestionAsk, utterance: string | undefined): boolean => {
	// "What does option two do?" asks about the options; "the second?", "Postgres?" or "use
	// Postgres?" picks one with a questioning voice.
	if (!utterance || !endsInQuestion(utterance)) {
		return false;
	}

	const labels = (findOpenQuestion(ask)?.question.options ?? []).map((option) =>
		readBareOption(option.label),
	);

	return !isSpokenPick(readBareOption(utterance), labels);
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

	const refused = refuseAnnouncedOnly({ state, ref: checked.ref, toolContext, what: 'answered' });

	if (refused) {
		return refused;
	}

	const debugNoteRequest = describeDebugNoteRequest(toolContext.utterance);

	if (debugNoteRequest) {
		return fail(debugNoteRequest);
	}

	const heardAsk = toolContext.asks.find((ask) => ask.ref === checked.ref);

	if (!heardAsk) {
		// The model reaches for answer when a session asked at the end of its turn: that reply is
		// words for the session, so it goes there instead of failing into a made-up explanation.
		const utterance = toolContext.utterance;
		const reply = chooseSentWords({
			utterance,
			part: typeof input.text === 'string' ? input.text : undefined,
			earlier: toolContext.recentUtterances ?? [],
			isWhole: utterance
				? isWholeSend({
						state,
						utterance,
						isOnlySend: (toolContext.actionsInTurn ?? 1) <= 1,
					})
				: false,
		}).text;

		// A forward beside it already took the words there, cleaned: they are not sent twice.
		if (toolContext.sentTo?.has(checked.ref)) {
			return succeed(`the words already went to ${checked.ref} in this turn`);
		}

		const asked = state.sessions[checked.ref]?.needsUser;

		// Asked while the developer was already speaking, and not said aloud before they began: they never
		// heard it, so these words are not its answer (they were said to someone else). needsUser is
		// written when the turn ends; a question spoken earlier in that turn was heard — one from an
		// earlier turn says nothing about this one.
		const turnStartedAt = state.sessions[checked.ref]?.requests.at(-1)?.at ?? 0;
		const isUnheard =
			asked !== null &&
			asked !== undefined &&
			toolContext.heardFrom !== undefined &&
			asked.at >= toolContext.heardFrom &&
			!findLastAskedAloud({
				spoken: state.spoken.filter((line) => line.at >= turnStartedAt),
				waitingRefs: [checked.ref],
				now: toolContext.now(),
				heardFrom: toolContext.heardFrom,
			});

		if (isUnheard) {
			return fail(
				`${checked.ref} asked that while the developer was speaking: they had not heard it, so their words are not its answer. Nothing was sent.`,
			);
		}

		if (!reply) {
			return fail(
				`${checked.ref} has nothing pending to answer: forward or send_to the words instead.`,
			);
		}

		// A bare "yes" with another session asking is that session's answer, picked on the wrong ref:
		// failing lets the kernel answer it there, where a forward would hand this one a stray yes.
		const askingElsewhere = toolContext.asks.find((ask) => ask.ref !== checked.ref);

		if (askingElsewhere && isBareAnswer(toolContext.utterance ?? reply)) {
			return fail(
				`${checked.ref} has nothing pending to answer; ${askingElsewhere.ref} is the one asking: answer it there. Nothing was sent.`,
			);
		}

		const misroutedAnswer = describeMisroutedAnswer(state, checked.ref, reply);

		if (misroutedAnswer) {
			return fail(misroutedAnswer);
		}

		// "Yes, do that" to a session that asked nothing still means something to it: the
		// words go there instead of failing into "nothing is waiting".
		return {
			...sendText({ state, ref: checked.ref, text: reply, kind: 'instruction', toolContext }),
			recordAs: recordAsSent({ ref: checked.ref, text: reply, toolContext }),
		};
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

	// A question about the options is not a pick: it goes to the session, which withdraws its
	// question, answers, and asks again.
	if (
		decision === 'choose' &&
		liveAsk.kind === 'question' &&
		toolContext.utterance !== undefined &&
		isClarifyingQuestion(liveAsk, toolContext.utterance)
	) {
		const said = toolContext.utterance.trim();

		return {
			...sendText({ state, ref: checked.ref, text: said, kind: 'question', toolContext }),
			recordAs: recordAsSent({ ref: checked.ref, text: said, kind: 'question', toolContext }),
		};
	}

	// Approving a command or a plan is the one call that must never be guessed from other words.
	const isApproval = heardAsk.kind !== 'question' && (decision === 'yes' || decision === 'always');
	const hasConsented =
		heardAsk.kind === 'command' || heardAsk.kind === 'redirect' ? isPlainConsent : isConsent;

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
