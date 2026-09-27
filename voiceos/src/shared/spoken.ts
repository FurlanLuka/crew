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
	const [workspace = '', worktree = ''] = label.split('/');
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

const isFilePath = (word: string): boolean => {
	// A worktree ref like store-front/main is worth saying; a longer path or a file name is noise.
	const bareWord = word.replace(/[.,;:!?)]+$/, '');

	return (
		bareWord.includes('/') && (bareWord.split('/').length > 2 || /\.[a-z0-9]{1,5}$/i.test(bareWord))
	);
};

export const cleanSpokenText = (text: string, maxWords = 70): string => {
	// Cleaned whatever the model returned: speech synthesis reads backticks and paths aloud.
	const words = text
		.replace(INLINE_CODE_PATTERN, '')
		.replace(URL_PATTERN, '')
		.replace(/[*_#>]/g, '')
		.split(/\s+/)
		.filter((word) => word && !isFilePath(word));

	return words.length > maxWords ? `${words.slice(0, maxWords).join(' ')}…` : words.join(' ');
};
