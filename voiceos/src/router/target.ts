// The developer's answer to "For checkout?", settled in code: the held words go where they said.
import type { Judge } from '../judge/judge.js';
import type { Store } from '../state/store.js';

export type TargetAnswer = 'yes' | 'no' | 'other';

// "Yes", "ja", "no", "ne", "here": an answer in any language. Anything else, or a check that did not
// come back, is new words.
export const readTargetAnswer = async (judge: Judge, utterance: string): Promise<TargetAnswer> => {
	const answer = await judge({ key: 'target_answer', utterance });

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
