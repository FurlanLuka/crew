import { isSdkAsk, type Input, type Stamped, type State } from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { answerInWords, isAnsweredInWords } from './asks.js';
import { isAsideInFlight, startAside } from './aside.js';
import { cancelCommand, findCommandAsk, holdCommand, readGuardedCommand } from './commands.js';
import { decideAck, deliverSend, NO_ACK } from './delivery.js';
import { pushNotice, updateSession, withoutEffects } from './helpers.js';
import { mergeOwed } from '../shared/ack.js';

type SendInput = Extract<Input, { type: 'send' }>;

export const reduceSend = (state: State, input: SendInput, stamped: Stamped): ReducerResult => {
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

		return holdCommand({ state: focusedState, ref: input.ref, command, text, stamped });
	}

	// A question about what it waits on ("why step 3?") is answered aside: the plan keeps waiting.
	if (sdkAsk && input.aside) {
		return isAsideInFlight(session, text)
			? withoutEffects(focusedState)
			: startAside({ state: focusedState, ref: input.ref, question: text, stamped });
	}

	if (sdkAsk) {
		const answered = answerInWords({ state: focusedState, ask: sdkAsk, text, stamped });
		// The running turn takes the words, so it owes their report too.
		const { effects, owed } = isAnsweredInWords(sdkAsk)
			? decideAck({ ref: input.ref, ack: input.ack, timing: 'now' })
			: NO_ACK;

		return {
			state: owed
				? updateSession(answered.state, input.ref, (current) => ({
						...current,
						reportOwed: mergeOwed(current.reportOwed, owed),
					}))
				: answered.state,
			effects: [...effects, ...answered.effects],
		};
	}

	// Anything else said while a command waits means the developer moved on from it.
	const commandAsk = findCommandAsk(state, input.ref);
	const current = commandAsk
		? cancelCommand({ state: focusedState, ask: commandAsk, stamped })
		: focusedState;

	// Checked again here: the session may have finished while the kernel was deciding.
	if (input.aside && session.status === 'running') {
		return isAsideInFlight(session, text)
			? withoutEffects(current)
			: startAside({ state: current, ref: input.ref, question: text, stamped });
	}

	return deliverSend({
		state: current,
		ref: input.ref,
		text,
		note: input.note?.trim() || undefined,
		isSpoken: Boolean(input.isSpoken),
		stamped,
		ack: input.ack,
	});
};
