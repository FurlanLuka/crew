// Speech-to-text writes it several ways: "hands-free", "hands free", "handsfree".
// Not "listening on": "the server is listening on 3000" is about the work.
const HANDS_FREE_PATTERN = /\bhands[\s-]?free\b|\b(?:start|stop) listening\b/i;
const ON_PATTERN = /\b(?:on|start|enable|resume)\b/i;
const OFF_PATTERN = /\b(?:off|stop|disable|pause)\b/i;

export type HandsFreeResult = 'changed' | 'already' | 'no_tab';

export const isAboutHandsFree = (utterance: string): boolean => HANDS_FREE_PATTERN.test(utterance);

export const readHandsFreeDirection = (utterance: string): boolean | null => {
	// The words decide on or off, not the model: "stop listening" must never turn it on.
	if (!isAboutHandsFree(utterance)) {
		return null;
	}

	const isOn = ON_PATTERN.test(utterance);
	const isOff = OFF_PATTERN.test(utterance);

	return isOn === isOff ? null : isOn;
};
