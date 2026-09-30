import type { Session } from './protocol.js';

// A reply ("yes, do it") says nothing about the work: the last request long enough to name it does.
const MIN_LABEL_WORDS = 4;
const MAX_LABEL_CHARS = 80;

// What a session works on, in the developer's own words: their last request that says something.
export const readWorkLabel = (session: Session): string | null => {
	const request = session.requests.findLast(
		(asked) => asked.text.trim().split(/\s+/).length >= MIN_LABEL_WORDS,
	);
	const text = request?.text.trim().replace(/\s+/g, ' ');

	if (!text) {
		return null;
	}

	return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS).trimEnd()}…` : text;
};
