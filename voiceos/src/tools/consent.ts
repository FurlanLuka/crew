const CONSENT_PATTERN =
	/\b(?:yes|yeah|yep|yup|sure|ok|okay|alright|all right|fine|always|allow(?: it)?|approve[ds]?|go ahead|go for it|do it|let it|proceed|ship it|sounds good|absolutely|of course)\b/i;

export const isConsent = (utterance: string): boolean => {
	return CONSENT_PATTERN.test(utterance);
};

// "Don't do it" holds "do it": clearing a session's context needs a yes with no no in it.
const REFUSAL_PATTERN = /\b(?:no|nope|not|don't|do not|never|cancel|stop|wait)\b/i;

export const isPlainConsent = (utterance: string): boolean => {
	return isConsent(utterance) && !REFUSAL_PATTERN.test(utterance);
};
