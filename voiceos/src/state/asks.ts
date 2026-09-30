import {
	isSdkAsk,
	type AllowOnce,
	type Denial,
	type Input,
	type PendingAsk,
	type PermissionDecision,
	type Session,
	type SdkAsk,
	type Stamped,
	type State,
} from '../shared/protocol.js';
import { buildRetryText } from '../shared/approval.js';
import { stripSessionName, toSpokenName } from '../shared/spoken.js';
import { findOpenQuestion, readOpenQuestions, type QuestionAsk } from '../shared/questions.js';
import type { AskResult, Effect, ReducerResult } from './reducer.js';
import { cancelCommand, describeCommandAloud, findCommandAsk } from './commands.js';
import {
	capWords,
	pushStreamItem,
	readLabel,
	sendNow,
	updateSession,
	withoutEffects,
} from './helpers.js';
import { findRedirectAsk, releaseRedirect } from './redirect.js';
import {
	clearHeldAsk,
	clearHeldLine,
	describeAnnouncement,
	holdLine,
	isOnAnotherSession,
	isOnScreen,
	isShortLine,
} from './held-lines.js';

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

export const completesAsk = (ask: PendingAsk): boolean =>
	// Words for an ask reach the session only once they settle it: one open question or none left.
	ask.kind !== 'question' || readOpenQuestions(ask).length <= 1;

export const isAskInput = (input: Input): input is AskInput => ASK_INPUT_SET.has(input.type);

export const closeAsk = (state: State, askId: string): State => {
	const ask = state.asks.find((pendingAsk) => pendingAsk.id === askId);

	if (!ask) {
		return state;
	}

	const asks = state.asks.filter((pendingAsk) => pendingAsk.id !== askId);
	const settled = clearHeldAsk({ ...state, asks }, askId);
	// A held command never blocks the turn: only the SDK's own asks do.
	const isStillBlocked = asks.some(
		(pendingAsk) => pendingAsk.ref === ask.ref && isSdkAsk(pendingAsk),
	);

	return updateSession(settled, ask.ref, (session) =>
		session.status === 'blocked' && !isStillBlocked ? { ...session, status: 'running' } : session,
	);
};

export const settleAsksForSession = (state: State, ref: string, message: string): ReducerResult => {
	// Stopping or interrupting a session denies all its asks at once; only the reducer settles them.
	// A held command has no SDK side to answer: it only closes.
	const effects: Effect[] = state.asks
		.filter((ask) => ask.ref === ref && isSdkAsk(ask))
		.map((ask) => ({
			type: 'resolve_ask',
			ref: ask.ref,
			askId: ask.id,
			result: { behavior: 'deny', message },
		}));

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
		case 'redirect':
			return `${label} is waiting to hear whether to switch: say yes, or it goes after.`;
	}
};

const ABOUT_WORDS = 6;

const describeAskAbout = (ask: PendingAsk): string | null => {
	// What the decision is about, in a few words: enough to choose whether to switch now.
	switch (ask.kind) {
		case 'plan':
			return 'a plan to approve';
		case 'permission':
			return `approval to ${capWords(ask.summary, ABOUT_WORDS).replace(/[.…]+$/, '')}`;
		case 'question': {
			const open = findOpenQuestion(ask)?.question;

			return open
				? open.header?.trim() || capWords(open.question, ABOUT_WORDS).replace(/[?…]+$/, '')
				: null;
		}

		default:
			return null;
	}
};

const isAnnouncedOnly = (state: State, ask: PendingAsk): boolean => {
	if (isOnScreen(state, ask.ref)) {
		return false;
	}

	// On another session's screen the session's own asks wait for the developer to switch, like its
	// lines: never read out, or docked, over the session they are looking at. Voice OS's own asks (a
	// held /clear, a redirect) answer the developer's words and are said where they are.
	if (isOnAnotherSession(state, ask.ref)) {
		return isSdkAsk(ask);
	}

	// Mission Control is the overview: only a plan, and a question too long to take in there, wait.
	if (ask.kind === 'plan') {
		return true;
	}

	const open = ask.kind === 'question' ? findOpenQuestion(ask)?.question : undefined;

	return open !== undefined && !isShortLine(open.question);
};

// The session's own line and the ask it announced come together; later than this, it was about
// something else.
const ASKED_BY_LINE_MS = 30_000;

interface FindLineThatAskedParams {
	state: State;
	ask: PendingAsk;
	now: number;
}

export const findLineThatAsked = ({ state, ask, now }: FindLineThatAskedParams): string | null => {
	// A question or plan the session asked in its own line, just before opening it, that the
	// developer heard start on screen: Voice OS does not ask it again. Returns that spoken line's id.
	const session = state.sessions[ask.ref];
	const line = session?.lineBeforeAsk;

	if (
		!line ||
		(ask.kind !== 'question' && ask.kind !== 'plan') ||
		!isOnScreen(state, ask.ref) ||
		now - line.at > ASKED_BY_LINE_MS
	) {
		return null;
	}

	// That very line, not an older one that happened to start playing after it was written.
	const heard = state.spoken.findLast(
		(spoken) =>
			spoken.ref === ask.ref &&
			spoken.source === 'narrator' &&
			spoken.at >= line.at &&
			!spoken.isCut &&
			stripSessionName(spoken.text).endsWith(stripSessionName(line.text)),
	);

	return heard?.id ?? null;
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

export const resolveAsk = (state: State, ask: PendingAsk, result: AskResult): ReducerResult => ({
	state: closeAsk(state, ask.id),
	effects: [{ type: 'resolve_ask', ref: ask.ref, askId: ask.id, result }],
});

const findAsk = <Kind extends PendingAsk['kind']>(
	state: State,
	askId: string,
	kind: Kind,
): Extract<PendingAsk, { kind: Kind }> | null => {
	const ask = state.asks.find((pendingAsk) => pendingAsk.id === askId);

	return ask?.kind === kind ? (ask as Extract<PendingAsk, { kind: Kind }>) : null;
};

export const isAllowedOnce = (
	allowOnce: AllowOnce | null,
	ask: PendingAsk,
): ask is Extract<PendingAsk, { kind: 'permission' }> =>
	allowOnce !== null &&
	ask.kind === 'permission' &&
	ask.toolName === allowOnce.toolName &&
	ask.summary === allowOnce.summary;

export const restoreAutoEffects = (session: Session | undefined): Effect[] =>
	// Auto mode is back as soon as the allowance is used or given up: one call, not the whole turn.
	session?.allowOnce ? [{ type: 'worker_set_mode', ref: session.ref, mode: 'auto' }] : [];

export const endAllowOnce = (state: State, ref: string): ReducerResult => {
	const effects = restoreAutoEffects(state.sessions[ref]);

	return effects.length > 0
		? {
				state: updateSession(state, ref, (session) => ({ ...session, allowOnce: null })),
				effects,
			}
		: withoutEffects(state);
};

const allowDenied = (state: State, denialId: string, stamped: Stamped): ReducerResult => {
	const denial = state.denials.find((entry) => entry.id === denialId);
	const session = denial ? state.sessions[denial.ref] : undefined;

	if (!denial || !session) {
		return withoutEffects(state);
	}

	const retryText = buildRetryText(denial.summary);
	// Default mode routes the retried call to Voice OS, which approves it without asking.
	const setModeEffect: Effect = { type: 'worker_set_mode', ref: denial.ref, mode: 'default' };
	// The retry is the session's to report: Voice OS only says the allowance went through.
	const saidEffect: Effect = {
		type: 'speak',
		text: `Allowed. ${toSpokenName(readLabel(state, denial.ref))} retries it.`,
		source: 'kernel',
		isReply: true,
		ref: denial.ref,
		priority: 'high',
		isAck: true,
	};
	const cleared = updateSession(
		{ ...state, denials: state.denials.filter((entry) => entry.id !== denial.id) },
		denial.ref,
		(deniedSession) => ({
			...deniedSession,
			allowOnce: {
				toolName: denial.toolName,
				summary: denial.summary,
				earlierAskIds: state.asks.filter((ask) => ask.ref === denial.ref).map((ask) => ask.id),
			},
		}),
	);

	if (session.status === 'idle') {
		const sent = sendNow({
			state: cleared,
			ref: denial.ref,
			text: retryText,
			itemId: stamped.id,
			at: stamped.at,
			isApproval: true,
		});

		return { state: sent.state, effects: [setModeEffect, ...sent.effects, saidEffect] };
	}

	// Pushed into the running turn, which takes it at once: queued, it would run after the turn ends
	// in auto mode again, and be blocked again.
	if (session.status === 'running' || session.status === 'blocked') {
		return {
			state: updateSession(cleared, denial.ref, (runningSession) =>
				pushStreamItem(runningSession, {
					id: stamped.id,
					at: stamped.at,
					kind: 'user',
					text: retryText,
					isApproval: true,
				}),
			),
			effects: [
				setModeEffect,
				{ type: 'worker_send', ref: denial.ref, text: retryText },
				saidEffect,
			],
		};
	}

	const queued = updateSession(cleared, denial.ref, (deniedSession) => ({
		...deniedSession,
		queue: [
			...deniedSession.queue,
			{ id: stamped.id, text: retryText, at: stamped.at, isRetry: true as const },
		],
	}));

	return { state: queued, effects: [setModeEffect, saidEffect] };
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

			return reduceAsk(
				state,
				{
					type: 'answer_question',
					askId: ask.id,
					answers: open ? { [open.question.question]: text } : {},
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

			if (!ask) {
				return withoutEffects(state);
			}

			const answered = resolveAsk(
				state,
				ask,
				buildPermissionResult(ask, input.decision, input.message),
			);
			// Another call asked while an allowance waited: once answered, auto mode is back. One that was
			// already open when it was given is not that call, and leaves it waiting.
			const isEarlier = state.sessions[ask.ref]?.allowOnce?.earlierAskIds.includes(ask.id) === true;
			const ended = isEarlier
				? withoutEffects(answered.state)
				: endAllowOnce(answered.state, ask.ref);

			return { state: ended.state, effects: [...answered.effects, ...ended.effects] };
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

			// The call the developer allowed, retried: approved at once, nothing said, nothing held.
			if (isAllowedOnce(state.sessions[ask.ref]?.allowOnce ?? null, ask)) {
				const ended = endAllowOnce(state, ask.ref);

				return {
					state: ended.state,
					effects: [
						{
							type: 'resolve_ask',
							ref: ask.ref,
							askId: ask.id,
							result: buildPermissionResult(ask, 'allow'),
						},
						...ended.effects,
					],
				};
			}

			// A "yes" said next would be meant for this ask: a /clear still held must not take it, and a
			// held switch goes after the current work (said so) rather than wait behind it.
			const heldCommand = findCommandAsk(state, ask.ref);
			const heldRedirect = findRedirectAsk(state, ask.ref);
			const withoutCommand = heldCommand
				? cancelCommand({ state, ask: heldCommand, stamped })
				: state;
			const released = heldRedirect
				? releaseRedirect({
						state: withoutCommand,
						ask: heldRedirect,
						stamped: { ...stamped, id: `${stamped.id}:kept` },
						isAnnounced: true,
					})
				: { state: withoutCommand, effects: [] };
			const cleared = released.state;
			const next = updateSession(
				{ ...cleared, asks: [...cleared.asks, ask] },
				ask.ref,
				(session) => ({
					...session,
					status: 'blocked',
					// One line asks one question: a second question after it is asked by Voice OS.
					...(ask.kind === 'question' || ask.kind === 'plan' ? { lineBeforeAsk: null } : {}),
				}),
			);

			const askedBy = findLineThatAsked({ state, ask, now: stamped.at });

			// Asked already in the session's own words: said once is enough. That line now counts as the
			// question asked aloud, so a bare "yes" still finds it.
			if (askedBy) {
				return {
					state: updateSession(
						{
							...next,
							spoken: next.spoken.map((spoken) =>
								spoken.id === askedBy ? { ...spoken, isAsking: true as const } : spoken,
							),
						},
						ask.ref,
						(session) => ({ ...session, askedByLine: ask.id }),
					),
					effects: released.effects,
				};
			}

			if (isAnnouncedOnly(state, ask)) {
				// High, not an alert: it never cuts off the session on screen.
				return {
					state: holdLine({
						state: next,
						ref: ask.ref,
						content: { kind: 'ask', askId: ask.id },
						stamped,
						isAnnounced: true,
					}),
					effects: [
						{
							type: 'speak',
							text: describeAnnouncement({
								label: readLabel(state, ask.ref),
								kind: 'needs',
								about: describeAskAbout(ask),
							}),
							source: 'alert',
							ref: ask.ref,
							priority: 'high',
							chime: 'needs',
						},
						...released.effects,
					],
				};
			}

			// On Mission Control, a short question said in full now: the session's held line would only
			// repeat it.
			const said =
				ask.kind === 'question' &&
				!isOnScreen(state, ask.ref) &&
				state.sessions[ask.ref]?.lineBeforeAsk
					? clearHeldLine(next, ask.ref)
					: next;

			return {
				state: said,
				effects: [
					{
						type: 'speak',
						text: describeAskAloud(ask, readLabel(state, ask.ref)),
						source: 'alert',
						ref: ask.ref,
						isAsking: true,
					},
					...released.effects,
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
						// Heard after the line playing, never cutting it: a burst of them cut each other off.
						priority: 'high',
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
