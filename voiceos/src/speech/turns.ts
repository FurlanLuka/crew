import { INTERRUPT_PATTERN, normalizeUtterance } from '../shared/spoken.js';

const DANGLING_WORDS = new Set([
	'and',
	'but',
	'or',
	'because',
	'the',
	'an',
	'my',
	'your',
	'our',
	'their',
	"let's",
	'i',
]);
const FILLER_WORDS = new Set(['um', 'uh', 'erm']);
const TRAILING_DASH_PATTERN = /(?:\s|^)?[—–-]\s*$|(?:…|\.\.\.)\s*$/;
const ASKING_WHO_PATTERN = /\b(?:can|could|would|will) you[.?!,\s]*$/;

const getLastWord = (text: string): string =>
	text
		.toLowerCase()
		.replace(/’/g, "'")
		.replace(/[.,!?;:]+$/g, '')
		.trim()
		.split(/\s+/)
		.at(-1) ?? '';

export const isUnfinished = (raw: string): boolean => {
	const text = raw.trim();

	if (!text) {
		return false;
	}

	if (TRAILING_DASH_PATTERN.test(text)) {
		return true;
	}

	if (ASKING_WHO_PATTERN.test(text.toLowerCase())) {
		return true;
	}

	// Only words that almost never end a spoken sentence: a finished command held by mistake waits.
	const lastWord = getLastWord(text);

	return DANGLING_WORDS.has(lastWord) || FILLER_WORDS.has(lastWord);
};

export const joinTurns = (held: string, next: string): string => {
	const start = held
		.trim()
		.replace(/(?:[—–-]|…|\.+)\s*$/, '')
		.trim();

	// Speech-to-text capitalises every turn; mid-sentence it reads as a new one.
	const rest = next.trim().replace(/^\p{Lu}(?=\p{Ll})/u, (letter) => letter.toLowerCase());

	return `${start} ${rest}`.trim();
};

export interface DecideTurnActionParams {
	held: string | null;
	text: string;
}

export interface TurnAction {
	kind: 'hold' | 'route';
	text: string;
}

export const decideTurnAction = ({ held, text }: DecideTurnActionParams): TurnAction => {
	const joined = held ? joinTurns(held, text) : text;
	// "Hold on—" or "Stop…" is cut off only in writing: said, it meant stop, so it goes at once.
	const isInterrupt = INTERRUPT_PATTERN.test(
		normalizeUtterance(joined.replace(/(?:[—–-]|…|\.\.\.)\s*$/, '')),
	);
	const shouldHold = isUnfinished(joined) && !isInterrupt;

	return { kind: shouldHold ? 'hold' : 'route', text: joined };
};
