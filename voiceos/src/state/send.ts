import { isSdkAsk, type Input, type Stamped, type State } from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { answerInWords, completesAsk, resolveAsk } from './asks.js';
import { isAsideInFlight, startAside } from './aside.js';
import { cancelCommand, findCommandAsk, holdCommand, readGuardedCommand } from './commands.js';
import { decideAck, deliverSend, NO_ACK } from './delivery.js';
import { pushNotice, updateSession, withoutEffects } from './helpers.js';
import { findRedirectAsk, releaseRedirect } from './redirect.js';
import { continueFirstHalf } from './continuation.js';
import { clearHeldLine } from './held-lines.js';
import type { QuestionAsk } from '../shared/questions.js';

type SendInput = Extract<Input, { type: 'send' }>;

export const describeWithdrawal = (ask: QuestionAsk, text: string): string => {
	// Answers already given are kept in the denial: asked again, the session need not ask them twice.
	const given = Object.entries(ask.answers ?? {}).map(
		([question, answer]) => `"${question}": "${answer}"`,
	);
	const denial = `The developer asked instead of choosing: "${text}". Answer in a <spoken> tag, then ask again.`;

	return given.length > 0 ? `${denial} Already answered, keep these: ${given.join('; ')}.` : denial;
};

interface WithdrawQuestionParams {
	state: State;
	ask: QuestionAsk;
	text: string;
	stamped: Stamped;
}

const withdrawQuestion = ({ state, ask, text, stamped }: WithdrawQuestionParams): ReducerResult => {
	// Asked about instead of answered: the session answers in its own turn and asks again, so the
	// developer hears the options again with the answer in mind (a plan or permission keeps waiting).
	const withdrawn = resolveAsk(state, ask, {
		behavior: 'deny',
		message: describeWithdrawal(ask, text),
	});

	// The line that asked it is out of date: the session asks again after answering.
	return {
		state: clearHeldLine(withdrawn.state, ask.ref),
		effects: [{ type: 'drop_speech', ref: ask.ref, before: stamped.at }, ...withdrawn.effects],
	};
};

const deliverWords = (state: State, input: SendInput, stamped: Stamped): ReducerResult => {
	const session = state.sessions[input.ref];
	const text = input.text.trim();

	if (!session || !text) {
		return withoutEffects(state);
	}

	const focusedState = { ...state, focus: input.ref };
	const sdkAsk = state.asks.filter(isSdkAsk).find((ask) => ask.ref === input.ref);
	const command = readGuardedCommand(text);

	if (command) {
		// Held beside an open permission, a "yes" could approve the wrong one: that ask goes first.
		if (sdkAsk) {
			return withoutEffects(
				pushNotice({
					state: focusedState,
					ref: input.ref,
					text: `/${command} not sent: answer what it is waiting on first.`,
					stamped,
					suffix: 'refused',
				}),
			);
		}

		// One held yes/no per session: a waiting switch is kept (queued) before the command is held.
		const redirectAsk = findRedirectAsk(focusedState, input.ref);
		const released = redirectAsk
			? releaseRedirect({
					state: focusedState,
					ask: redirectAsk,
					stamped: { ...stamped, id: `${stamped.id}:kept` },
					isAnnounced: false,
				})
			: { state: focusedState, effects: [] };
		const held = holdCommand({ state: released.state, ref: input.ref, command, text, stamped });

		return { state: held.state, effects: [...released.effects, ...held.effects] };
	}

	if (sdkAsk?.kind === 'question' && input.aside) {
		return withdrawQuestion({ state: focusedState, ask: sdkAsk, text, stamped });
	}

	// A question about what it waits on ("why step 3?") is answered aside: the plan keeps waiting.
	if (sdkAsk && input.aside) {
		return isAsideInFlight(session, text)
			? withoutEffects(focusedState)
			: startAside({
					state: focusedState,
					ref: input.ref,
					question: text,
					note: input.note?.trim() || undefined,
					stamped,
				});
	}

	if (sdkAsk) {
		const answered = answerInWords({ state: focusedState, ask: sdkAsk, text, stamped });
		// The running turn takes the words, so it owes their report too.
		const { effects, isOwed } = completesAsk(sdkAsk)
			? decideAck({ ref: input.ref, ack: input.ack, timing: 'now' })
			: NO_ACK;

		// Answered by voice: what it still had to say about the question is out of date.
		const dropped: Effect[] = input.isSpoken
			? [{ type: 'drop_speech', ref: input.ref, before: stamped.at }]
			: [];

		const heard = clearHeldLine(answered.state, input.ref);

		return {
			state: isOwed
				? updateSession(heard, input.ref, (current) => ({ ...current, reportOwed: true }))
				: heard,
			effects: [...dropped, ...effects, ...answered.effects],
		};
	}

	// Anything else said while a command or a switch waits means the developer moved on from it:
	// the command is dropped, the switch kept for after the current work (it holds their words).
	const commandAsk = findCommandAsk(state, input.ref);
	const redirectAsk = findRedirectAsk(state, input.ref);
	const withoutCommand = commandAsk
		? cancelCommand({ state: focusedState, ask: commandAsk, stamped })
		: focusedState;
	const released = redirectAsk
		? releaseRedirect({
				state: withoutCommand,
				ask: redirectAsk,
				stamped: { ...stamped, id: `${stamped.id}:kept` },
				isAnnounced: false,
			})
		: { state: withoutCommand, effects: [] };
	const current = released.state;

	// Checked again here: the session may have finished while the kernel was deciding.
	if (input.aside && session.status === 'running') {
		return isAsideInFlight(session, text)
			? withoutEffects(current)
			: startAside({
					state: current,
					ref: input.ref,
					question: text,
					note: input.note?.trim() || undefined,
					stamped,
				});
	}

	const delivered = deliverSend({
		state: current,
		ref: input.ref,
		text,
		note: input.note?.trim() || undefined,
		isSpoken: Boolean(input.isSpoken),
		stamped,
		ack: input.ack,
		isNow: Boolean(input.isNow),
	});

	return { state: delivered.state, effects: [...released.effects, ...delivered.effects] };
};

interface FindCarrierIdParams {
	state: State;
	ref: string;
	stamped: Stamped;
	text: string;
}

const findCarrierId = ({ state, ref, stamped, text }: FindCarrierIdParams): string | null => {
	// What now carries the words just said: a queued message, the running turn, an aside, a held
	// switch — or the follow-up they were merged into.
	const session = state.sessions[ref];

	if (!session) {
		return null;
	}

	const isHere =
		session.queue.some((message) => message.id === stamped.id) ||
		session.currentSendId === stamped.id ||
		session.stream.some((item) => item.id === stamped.id && item.kind === 'aside') ||
		state.asks.some((ask) => ask.id === stamped.id && ask.kind === 'redirect');

	if (isHere) {
		return stamped.id;
	}

	const head = session.queue[0];

	return head?.isFollowUp && head.text.trimEnd().endsWith(text) ? head.id : null;
};

const rememberSpoken = (
	result: ReducerResult,
	input: SendInput,
	stamped: Stamped,
): ReducerResult => {
	// Anything else the words became (an answer, a held command) is not replaceable: forgotten.
	const text = input.text.trim();
	const carrierId = findCarrierId({ state: result.state, ref: input.ref, stamped, text });

	return {
		...result,
		state: {
			...result.state,
			lastSpokenSend: carrierId ? { ref: input.ref, id: carrierId, text, at: stamped.at } : null,
		},
	};
};

export const reduceSend = (state: State, input: SendInput, stamped: Stamped): ReducerResult => {
	if (!input.isSpoken) {
		return deliverWords(state, input, stamped);
	}

	if (input.continues) {
		const continued = continueFirstHalf({ ...state, focus: input.ref }, input, stamped);

		if (continued) {
			return continued;
		}

		// The first half already ran its course: only the new words go, as any words would.
		const rest = input.continues.rest.trim();

		return rest
			? reduceSend(
					state,
					{
						...input,
						text: rest,
						continues: undefined,
						...(input.continues.isAside ? { aside: true } : {}),
					},
					stamped,
				)
			: withoutEffects(state);
	}

	return rememberSpoken(deliverWords(state, input, stamped), input, stamped);
};
