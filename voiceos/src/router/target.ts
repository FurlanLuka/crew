// The developer's answer to "For checkout?", read by the judge: the held words go where they said.
import type { Judge } from '../judge/judge.js';
import type { Store } from '../state/store.js';

export type TargetAnswer = 'yes' | 'no' | 'other';

// "Yes", "ja", "no", "ne", "here": an answer in any language. Anything else, or a check that did not
// come back, is new words.
// session: how the session asked about is named, so "checkout" or "the checkout one" is a yes.
export const readTargetAnswer = async (
	judge: Judge,
	utterance: string,
	session?: string,
): Promise<TargetAnswer> => {
	const answer = await judge({
		key: 'target_answer',
		utterance,
		...(session ? { context: `The session asked about: ${session}` } : {}),
	});

	return answer === 'yes' || answer === 'no' ? answer : 'other';
};

// Sends the held words to where the answer points; a no, silence or new words keep them on the screen.
export const settleTarget = (store: Store, toTarget: boolean): void => {
	const ask = store.state.targetAsk;

	if (!ask) {
		return;
	}

	store.dispatch({ type: 'settle_target', at: ask.at, toTarget });
	store.dispatch({
		type: 'send',
		ref: toTarget ? ask.ref : ask.screen,
		text: ask.text,
		isSpoken: true,
	});
};
