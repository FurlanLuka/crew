// A session opens a message for the developer with <spoken>…</spoken>, what Voice OS says aloud;
// <spoken asks> marks a question it waits on. The rest of the message is for the screen. Only a
// tag at the very top counts: one quoted further down (in code, in an explanation) is just text.

export interface SpokenTag {
	text: string;
	isAsking: boolean;
}

// A session sometimes closes <spoken asks> with </spoken asks>: the same tag.
const LEADING_TAG_PATTERN = /^\s*<spoken(\s+asks)?\s*>([\s\S]*?)<\/spoken(?:\s+asks)?\s*>/i;
// Still streaming at the top: the start of "<spoken", or an open tag with its line so far.
const LEADING_OPEN_TAG_PATTERN =
	/^\s*<(?:s(?:p(?:o(?:k(?:e(?:n(?:\s[^>]*)?(?:>[\s\S]*)?)?)?)?)?)?)?$/i;

export const readSpokenTag = (text: string): SpokenTag | null => {
	const match = LEADING_TAG_PATTERN.exec(text);
	const spoken = match?.[2]?.trim();

	return spoken ? { text: spoken, isAsking: Boolean(match?.[1]) } : null;
};

export const stripSpokenTag = (text: string): string =>
	text.replace(LEADING_TAG_PATTERN, '').trim();

export const stripStreamingTag = (draft: string): string =>
	// A draft may stop mid-tag; a finished message never loses text to an unclosed one.
	stripSpokenTag(draft).replace(LEADING_OPEN_TAG_PATTERN, '').trim();

export const readShownText = (text: string): string =>
	// A message that was only a spoken line (an ack) still shows those words on the page.
	stripSpokenTag(text) || readSpokenTag(text)?.text || '';
