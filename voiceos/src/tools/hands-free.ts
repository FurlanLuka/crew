import type { ListenMode } from '../shared/protocol.js';

// Speech-to-text writes it several ways: "hands-free", "hands free", "handsfree".
// Not "listening on": "the server is listening on 3000" is about the work.
const HANDS_FREE_PATTERN = /\bhands[\s-]?free\b|\b(?:start|stop) listening\b/i;
// "on demand" only as a listening mode: "scale the workers on demand" is about the work.
const ON_DEMAND_PATTERN =
	/\b(?:(?:switch|go|change|set|turn|put)(?: it| me)?(?: to| into| on)?|use) on[\s-]?demand\b|\bon[\s-]?demand (?:mode|listening)\b|\bwake[\s-]?word\b|\blisten(?:ing)? for (?:voice ?o ?s|my name|your name)\b/i;
const PUSH_PATTERN = /\bpush[\s-]to[\s-]talk\b/i;
// Naming hands-free as the mode to use is a choice too: "switch to hands-free", "go hands-free".
const CHOOSE_HANDS_FREE_PATTERN =
	/\b(?:(?:switch|change|set|put)(?: it| me)?(?: to| into)|go|use|back to)\s+hands[\s-]?free\b/i;
const ON_PATTERN = /\b(?:on|start|enable|resume)\b/i;
const OFF_PATTERN = /\b(?:off|stop|disable|pause)\b/i;

export type HandsFreeResult = 'changed' | 'already' | 'no_tab';

export const isAboutHandsFree = (utterance: string): boolean =>
	HANDS_FREE_PATTERN.test(utterance) ||
	ON_DEMAND_PATTERN.test(utterance) ||
	PUSH_PATTERN.test(utterance);

export const readListenMode = (utterance: string): ListenMode | null => {
	// The words decide the mode, not the model: "stop listening" must never turn listening on.
	// "Stop listening for Voice OS", "turn off on demand mode": leaving it, back to push to talk.
	if (ON_DEMAND_PATTERN.test(utterance)) {
		return OFF_PATTERN.test(utterance) ? 'push' : 'on-demand';
	}

	if (PUSH_PATTERN.test(utterance)) {
		return 'push';
	}

	if (CHOOSE_HANDS_FREE_PATTERN.test(utterance)) {
		return 'hands-free';
	}

	if (!HANDS_FREE_PATTERN.test(utterance)) {
		return null;
	}

	const isOn = ON_PATTERN.test(utterance);
	const isOff = OFF_PATTERN.test(utterance);

	if (isOn === isOff) {
		return null;
	}

	return isOn ? 'hands-free' : 'push';
};
