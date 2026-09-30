// The retry Voice OS sends for a call the developer allowed once. Its words are the session's
// instruction; the page shows only what was allowed, so it never reads as the developer's own message.

const RETRY_PREFIX = 'The user allows this once: retry "';
const RETRY_SUFFIX = '" now.';

export const buildRetryText = (summary: string): string =>
	`${RETRY_PREFIX}${summary}${RETRY_SUFFIX}`;

// A restored transcript has only the prompt text to go on.
export const isRetryText = (text: string): boolean => text.startsWith(RETRY_PREFIX);

export const readApprovalSummary = (text: string): string => {
	if (!isRetryText(text)) {
		return text;
	}

	const body = text.slice(RETRY_PREFIX.length);

	return body.endsWith(RETRY_SUFFIX) ? body.slice(0, -RETRY_SUFFIX.length) : body;
};
