// The developer's answer to "For checkout?", settled in code: the held words go where they said.
import { isPlainConsent } from '../tools/consent.js';
import { normalizeSaid } from '../state/helpers.js';
import type { Store } from '../state/store.js';

const MAX_BARE_WORDS = 4;
const BARE_NO_PATTERN = /^(?:no|nope|nah|not that one|here|stay|keep it here)\b/i;

export type TargetAnswer = 'yes' | 'no' | 'other';

// "Yes", "yeah, for checkout": the notifier. "No", "here": the screen. Anything else is new words.
export const readTargetAnswer = (utterance: string): TargetAnswer => {
	const said = normalizeSaid(utterance).replace(/[.!?,]+/g, '');

	if (said.split(' ').length > MAX_BARE_WORDS) {
		return 'other';
	}

	if (BARE_NO_PATTERN.test(said)) {
		return 'no';
	}

	return isPlainConsent(said) ? 'yes' : 'other';
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
