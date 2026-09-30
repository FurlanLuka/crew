import { splitRef } from './machine-ref.js';

// One table for spoken numbers, so resolveRef and the kernel's stop guard hear "work one" alike.
export const NUMBER_WORDS = [
	'zero',
	'one',
	'two',
	'three',
	'four',
	'five',
	'six',
	'seven',
	'eight',
	'nine',
	'ten',
] as const;

export const toSpokenPart = (part: string): string => {
	// "wrk1" → "work 1": the narrator, speech-to-text terms and the stop guard all hear names this way.
	return part.replace(/^wrk(\d+)$/, 'work $1').replace(/-/g, ' ');
};

export const toSpokenName = (label: string): string => {
	const { workspace, worktree } = splitRef(label);
	const spokenWorkspace = toSpokenPart(workspace);

	return worktree ? `${spokenWorkspace}, ${toSpokenPart(worktree)}` : spokenWorkspace;
};

export const stripSessionName = (text: string): string => {
	// For the session on screen, the developer knows who is talking.
	const body = text
		.trim()
		.replace(/^[:,\s]+/, '')
		.replace(/^asks:?\s*/i, '');

	return body ? `${body.charAt(0).toUpperCase()}${body.slice(1)}` : '';
};

export const prefixSessionName = (label: string, text: string): string => {
	const body = text.trim().replace(/^[:,\s]+/, '');

	if (!body) {
		return '';
	}

	if (/^(asks|wants|needs)\b/i.test(body)) {
		return `${toSpokenName(label)} ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
	}

	return `${toSpokenName(label)}: ${body}`;
};

// Hands-free keeps these as the developer's even right after Voice OS said them, and lets them cut speech.
export const STANDALONE_WORDS = new Set(['stop', 'wait', 'cancel', 'halt', 'abort', 'no', 'yes']);

// Soniox reads these bracketed cues as delivery, not words. Only these: an unknown tag may be read
// aloud, and SSML (<break time="1s"/>) is read aloud as markup.
export const ALLOWED_TAGS = [
	'laughs',
	'chuckles',
	'sighs',
	'pause',
	'warm',
	'reassuringly',
	'excited',
	'curious',
	'relieved',
] as const;

const ALLOWED_TAG_PATTERN = new RegExp(`\\s*\\[(?:${ALLOWED_TAGS.join('|')})\\]`, 'gi');

export const stripTags = (text: string): string =>
	// Tags are for the voice only: what is stored, shown, counted or matched reads the words.
	text.replace(ALLOWED_TAG_PATTERN, '').trim();

// A question read aloud or typed often closes on its quote or bracket: 'asks "which one?"'.
export const endsInQuestion = (text: string): boolean => /\?["'”’)\]]*$/.test(stripTags(text));

export const INTERRUPT_PATTERN = /^(stop|stop it|cancel|cancel that|halt|abort|hold on|wait)$/;

export const normalizeUtterance = (text: string): string =>
	text
		.toLowerCase()
		.replace(/[“”"`]/g, '')
		.trim()
		.replace(/[.!?]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim();

const INLINE_CODE_PATTERN = /`[^`]*`/g;
const URL_PATTERN = /https?:\/\/\S+/g;
const MARKDOWN_LINK_PATTERN = /\[([^[\]]+)\]\([^()\s]*\)/g;
// Tag-shaped only, so "a < b" survives; removed whole before the "*_#>" strip leaves its insides.
const MARKUP_PATTERN = /<\/?[a-z][^<>]*>/gi;
const BRACKET_PATTERN = /\[([^[\]]*)\]/g;
const ALLOWED_TAG_NAMES = new Set<string>(ALLOWED_TAGS);

const keepAllowedTag = (_match: string, name: string): string => {
	const tag = name.trim().toLowerCase();

	return ALLOWED_TAG_NAMES.has(tag) ? `[${tag}]` : '';
};

const isFilePath = (word: string): boolean => {
	// A worktree ref like store-front/main is worth saying; a longer path or a file name is noise.
	const bareWord = word.replace(/[.,;:!?)]+$/, '');

	return (
		bareWord.includes('/') && (bareWord.split('/').length > 2 || /\.[a-z0-9]{1,5}$/i.test(bareWord))
	);
};

const SENTENCE_END_PATTERN = /[.!?]["'”’)\]]*$/;
// A period that ends an abbreviation, a version or a list number, not the sentence: "e.g." "(e.g."
// "vs." "v2." "1.". A spoken list reads "1. Run the tests. 2. Push.": the number starts an item.
const FALSE_SENTENCE_END_PATTERN =
	/^["'“‘([]*(?:e\.g|i\.e|vs|mr|mrs|ms|dr|approx|v\d+(?:\.\d+)*|\d{1,2})\.$/i;
const MORE_ON_SCREEN = 'More on screen.';

const isSentenceEnd = (word: string): boolean =>
	SENTENCE_END_PATTERN.test(word) && !FALSE_SENTENCE_END_PATTERN.test(word);

export const cutAtSentence = (words: string[], cap: number): string => {
	// A line cut mid-sentence loses its point (often its closing question), so the cut lands on a
	// sentence end: the last within the cap when that keeps enough, else the next one within twice
	// the cap. A runaway without one is cut at the cap. The rest is on the page, and the developer
	// is told so.
	if (words.length <= cap) {
		return words.join(' ');
	}

	const finish = (kept: string[], mark = '') => `${kept.join(' ')}${mark} ${MORE_ON_SCREEN}`;
	const lastEnd = words.slice(0, cap).findLastIndex(isSentenceEnd);

	if (lastEnd + 1 >= cap / 2) {
		return finish(words.slice(0, lastEnd + 1));
	}

	const nextEnd = words.slice(cap, cap * 2).findIndex(isSentenceEnd);

	if (nextEnd !== -1) {
		const end = cap + nextEnd + 1;

		return end === words.length ? words.join(' ') : finish(words.slice(0, end));
	}

	return finish(words.slice(0, cap), '…');
};

export const cleanSpokenText = (text: string, maxWords = 70): string => {
	// Cleaned whatever the model returned: speech synthesis reads backticks, paths and markup aloud.
	const words = text
		.replace(INLINE_CODE_PATTERN, '')
		.replace(MARKDOWN_LINK_PATTERN, '$1')
		.replace(URL_PATTERN, '')
		.replace(MARKUP_PATTERN, '')
		.replace(BRACKET_PATTERN, keepAllowedTag)
		.replace(/[*_#>]/g, '')
		.split(/\s+/)
		.filter((word) => word && !isFilePath(word));

	return cutAtSentence(words, maxWords);
};

// Only a runaway is cut: the session wrote its line to be heard, closing question included.
const SESSION_LINE_MAX_WORDS = 200;

export const cleanSessionLine = (text: string): string =>
	cleanSpokenText(text, SESSION_LINE_MAX_WORDS);
