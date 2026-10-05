import { isPeerAsk } from '../shared/protocol.js';
import type { Judge } from '../judge/judge.js';
import { refuseInactive } from './activate.js';
import { SAID_TO_VOICE_OS, isSaidToVoiceOs } from './said-to-voice-os.js';
import { createLogger } from '../log.js';
import {
	isSwitchOfferFresh,
	type Action,
	type PendingAsk,
	type State,
} from '../shared/protocol.js';
import { findOpenQuestion, hasOpenQuestionMoved, type QuestionAsk } from '../shared/questions.js';
import { type ToolResult, checkRef, fail, succeed } from './results.js';
import {
	describeMisroutedAnswer,
	isBareAnswer,
	chooseSentWords,
	isWholeSend,
	recordAsSent,
	sendText,
	type SentWords,
} from './send.js';
import { findLastAskedAloud, wasJustHeardAbout } from './asked-aloud.js';
import { findSessionsNamedIn } from './session-naming.js';
import type { ToolContext } from './tools.js';
import { forwardChosen } from './forward.js';
import { refuseAnnouncedOnly } from './announced.js';
import { endsInQuestion } from '../shared/spoken.js';
import { guardSendTo } from './send-guard.js';

const log = createLogger('tools');

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

		case 'work':
		case 'secret': {
			if (decision === 'choose' || decision === 'always') {
				return { ok: false, error: "another session's request is answered yes or no" };
			}

			return {
				ok: true,
				actions: [{ type: 'answer_peer', askId: ask.id, isApproved: decision !== 'no' }],
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

// "Use Postgres?" for the label "Postgres", or "Postgres?" for "Use Postgres": a pick said with a
// few words around it. Longer, it is a sentence about the option ("what does Postgres do").
const MAX_PICK_EXTRA_WORDS = 2;

const countWords = (text: string): number => text.split(' ').filter(Boolean).length;

const hasPhrase = (text: string, phrase: string): boolean => ` ${text} `.includes(` ${phrase} `);

export type OptionReply = 'pick' | 'question' | 'other';

interface ReadOptionReplyParams {
	ask: QuestionAsk;
	utterance: string;
	judge: Judge;
	// Where the developer could go instead: "go into crew" beside an option "Crew project" is a place.
	sessions: string[];
}

// Whether words the kernel answered a question with pick an option, ask about them, or are about
// something else ("go into crew" beside an option named "Crew project").
export const readOptionReply = async ({
	ask,
	utterance,
	judge,
	sessions,
}: ReadOptionReplyParams): Promise<OptionReply> => {
	const labels = (findOpenQuestion(ask)?.question.options ?? []).map((option) =>
		readBareOption(option.label),
	);
	const bare = readBareOption(utterance);
	const isQuestion = endsInQuestion(utterance);

	// A label said back, or an English ordinal, is a pick without asking.
	if (ORDINALS.has(bare) || labels.includes(bare)) {
		return 'pick';
	}

	const named = labels.filter(
		(label) => label && (hasPhrase(bare, label) || hasPhrase(label, bare)),
	);

	// One or more options named in a statement is the kernel's reading to trust; two named, or one
	// inside a longer question, is weighing them.
	if (named.length > 0) {
		if (!isQuestion) {
			return 'pick';
		}

		if (named.length > 1 || countWords(bare) > countWords(named[0]!) + MAX_PICK_EXTRA_WORDS) {
			return 'question';
		}
	}

	const reply = await judge({
		key: 'option_reply',
		utterance,
		context: `The options: ${labels.map((label) => `"${label}"`).join(', ')}. Sessions the developer can go to: ${sessions.join(', ')}.`,
	});

	// Unclear never answers on a guess: a question goes to the session, anything else back to routing.
	return reply === 'unclear' ? (isQuestion ? 'question' : 'other') : reply;
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
	const now = toolContext.now();
	const offer = state.switchOffer;
	// "Switch there?" asked after its question: a bare yes may be the switch's, so the question is no
	// longer alone.
	const isOfferedSince =
		isSwitchOfferFresh(offer, now) &&
		offer.ref !== ref &&
		asks.every((ask) => ask.ref !== ref || ask.at < offer.at);
	const isAlone = asks.every((ask) => ask.ref === ref) && !isOfferedSince;

	if (isAlone || utterance === undefined || toolContext.screen === ref) {
		return true;
	}

	const lastAskedAloud = findLastAskedAloud({
		spoken: state.spoken,
		waitingRefs: [...asks.map((ask) => ask.ref), ...(isOfferedSince ? [offer.ref] : [])],
		now,
	});

	return lastAskedAloud?.ref === ref || findSessionsNamedIn(state, utterance).includes(ref);
};

export interface AnswerAskParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
}

export const answerAsk = async ({
	state,
	input,
	toolContext,
}: AnswerAskParams): Promise<ToolResult> => {
	const checked = checkRef(state, input.ref);

	// An inactive session asks nothing: the words meant as its answer, chosen as for any send, are
	// kept for it.
	if (!checked.ok) {
		if (!checked.inactive) {
			return fail(checked.error);
		}

		const { text } = await chooseSentWords({
			judge: toolContext.judge,
			utterance: toolContext.utterance,
			part: typeof input.text === 'string' ? input.text : undefined,
			earlier: toolContext.recentUtterances ?? [],
			isWhole: false,
		});

		return refuseInactive({ ref: checked.inactive, toolContext, ...(text ? { words: text } : {}) });
	}

	const refused = await refuseAnnouncedOnly({
		state,
		ref: checked.ref,
		toolContext,
		what: 'answered',
	});

	if (refused) {
		return refused;
	}

	const heardAsk = toolContext.asks.find((ask) => ask.ref === checked.ref);

	if (!heardAsk) {
		// The model reaches for answer when a session asked at the end of its turn: that reply is
		// words for the session, so it goes there instead of failing into a made-up explanation.
		const utterance = toolContext.utterance;
		const { text: reply } = await chooseSentWords({
			judge: toolContext.judge,
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
		});

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

		if (
			askingElsewhere &&
			(await isBareAnswer(toolContext.judge, toolContext.utterance ?? reply))
		) {
			return fail(
				`${checked.ref} has nothing pending to answer; ${askingElsewhere.ref} is the one asking: answer it there. Nothing was sent.`,
			);
		}

		const misroutedAnswer = await describeMisroutedAnswer({
			state,
			ref: checked.ref,
			text: reply,
			judge: toolContext.judge,
		});

		if (misroutedAnswer) {
			return fail(misroutedAnswer);
		}

		// A reply to the question it ended its turn on is its answer, named or not — once the developer
		// heard that question. Otherwise words reach it only the way send_to would send them: named in
		// them (the answer tool is no way around the send guard).
		const heardFrom = toolContext.heardFrom ?? toolContext.now();
		const isAskedAloud =
			asked !== null &&
			asked !== undefined &&
			(findLastAskedAloud({
				spoken: state.spoken,
				waitingRefs: [checked.ref],
				now: toolContext.now(),
				heardFrom,
			})?.ref === checked.ref ||
				wasJustHeardAbout({ spoken: state.spoken, ref: checked.ref, heardFrom }));
		const words: SentWords = { text: reply, source: 'said' };
		const guarded = isAskedAloud
			? null
			: await guardSendTo({ state, ref: checked.ref, words, toolContext });

		if (guarded === 'screen') {
			return forwardChosen({ words, kind: 'instruction', toolContext });
		}

		if (guarded) {
			return guarded;
		}

		if (isSaidToVoiceOs({ state, ref: checked.ref, toolContext })) {
			return fail(SAID_TO_VOICE_OS);
		}

		// "Yes, do that" to a session that asked nothing still means something to it: the
		// words go there instead of failing into "nothing is waiting".
		return {
			...(await sendText({
				state,
				ref: checked.ref,
				text: reply,
				kind: 'instruction',
				toolContext,
			})),
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

	const optionReply =
		decision === 'choose' && liveAsk.kind === 'question' && toolContext.utterance !== undefined
			? await readOptionReply({
					ask: liveAsk,
					utterance: toolContext.utterance,
					judge: toolContext.judge,
					sessions: Object.keys(state.sessions),
				})
			: 'pick';

	if (optionReply === 'other') {
		log.info('answer refused: the words pick no option', { ref: checked.ref });

		return fail(
			'Not answered: those words choose none of the options; they are about something else. Do what they ask (a switch, words for another session); the question keeps waiting.',
		);
	}

	// A question about the options is not a pick: it goes to the session, which withdraws its
	// question, answers, and asks again.
	if (optionReply === 'question' && toolContext.utterance !== undefined) {
		if (isSaidToVoiceOs({ state, ref: checked.ref, toolContext })) {
			return fail(SAID_TO_VOICE_OS);
		}

		const said = toolContext.utterance.trim();

		return {
			...(await sendText({ state, ref: checked.ref, text: said, kind: 'question', toolContext })),
			recordAs: recordAsSent({ ref: checked.ref, text: said, kind: 'question', toolContext }),
		};
	}

	// Approving a command or a plan is the one call that must never be guessed from other words: the
	// judge, not the kernel, says whether they said yes. Clearing context or stopping work needs a
	// yes with no holding back in it at all.
	const isApproval = heardAsk.kind !== 'question' && (decision === 'yes' || decision === 'always');
	const consentKey =
		heardAsk.kind === 'command' || heardAsk.kind === 'redirect' || isPeerAsk(heardAsk)
			? 'approves_plainly'
			: 'approves';

	if (
		isApproval &&
		toolContext.utterance !== undefined &&
		(await toolContext.judge({ key: consentKey, utterance: toolContext.utterance })) !== 'yes'
	) {
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
