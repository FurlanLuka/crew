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
// "mm", "hmmm", "mhm", "uh-huh": a breath or a murmur, not the developer going on.
const MURMUR_PATTERN = /^(?:m+|h+m+|m+h+m+|huh)$/;
// Said alone right after a command not yet sent, these drop it. "Wait" and "hold on" are not here:
// they start a correction, which should reach the kernel with what it corrects.
const CANCEL_PATTERN = /^(?:stop|stop it|cancel|cancel that|halt|abort|never ?mind)$/;
const TRAILING_CUT_PATTERN = /(?:[—–-]|…|\.\.\.)\s*$/;
const TRAILING_DASH_PATTERN = /(?:\s|^)?[—–-]\s*$|(?:…|\.\.\.)\s*$/;
const ASKING_WHO_PATTERN = /\b(?:can|could|would|will) you[.?!,\s]*$/;
// "Can you set up." — a request cut off before its object; "Can you push?" is complete.
const OBJECT_MISSING_PATTERN =
	/\b(?:can|could|would|will) you \w+ (?:up|out|into|through|with|about|for|to|from)[.?!,\s]*$/;

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

	const lowerText = text.toLowerCase();

	if (ASKING_WHO_PATTERN.test(lowerText) || OBJECT_MISSING_PATTERN.test(lowerText)) {
		return true;
	}

	// Only words that almost never end a spoken sentence: a finished command held by mistake waits.
	const lastWord = getLastWord(text);

	return DANGLING_WORDS.has(lastWord) || FILLER_WORDS.has(lastWord);
};

export interface JoinTurnsOptions {
	// The held turn was a finished sentence (a settle): its end and the next one's capital stay,
	// so two quick commands remain two sentences for the kernel.
	keepBoundary?: boolean;
}

export const joinTurns = (
	held: string,
	next: string,
	{ keepBoundary = false }: JoinTurnsOptions = {},
): string => {
	if (keepBoundary) {
		// Speech-to-text may leave the period off; the kernel still needs the sentence to end.
		const sentence = held.trim().replace(/[,;:]+$/, '');

		return `${/[.!?]$/.test(sentence) ? sentence : `${sentence}.`} ${next.trim()}`.trim();
	}

	const start = held
		.trim()
		.replace(/(?:[—–-]|…|\.+)\s*$/, '')
		.trim();

	// Speech-to-text capitalises every turn; mid-sentence it reads as a new one.
	// A one-letter word ("A workspace?") too, but never "I".
	const rest = next
		.trim()
		.replace(/^(?!I\b)\p{Lu}(?=\p{Ll}|\s)/u, (letter) => letter.toLowerCase());

	return `${start} ${rest}`.trim();
};

export const hasRealWords = (text: string): boolean =>
	text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
		.split(/[\s-]+/)
		.some((word) => word && !FILLER_WORDS.has(word) && !MURMUR_PATTERN.test(word));

export type HoldKind = 'hold' | 'settle';

export interface DecideTurnActionParams {
	held: string | null;
	heldKind?: HoldKind | null;
	text: string;
}

export interface TurnAction {
	// hold: unfinished, waits for the rest; settle: finished, waits a moment in case it goes on;
	// route: goes now; cancel: drops what was held and routes the word itself.
	kind: HoldKind | 'route' | 'cancel';
	text: string;
}

export const decideTurnAction = ({
	held,
	heldKind = null,
	text,
}: DecideTurnActionParams): TurnAction => {
	const said = normalizeUtterance(text.replace(TRAILING_CUT_PATTERN, ''));

	if (held && CANCEL_PATTERN.test(said)) {
		return { kind: 'cancel', text };
	}

	const joined = held ? joinTurns(held, text, { keepBoundary: heldKind === 'settle' }) : text;
	// "Hold on—" or "Stop…" is cut off only in writing: said, it meant stop, so it goes at once.
	const isInterrupt = INTERRUPT_PATTERN.test(
		normalizeUtterance(joined.replace(TRAILING_CUT_PATTERN, '')),
	);

	if (isInterrupt) {
		return { kind: 'route', text: joined };
	}

	return { kind: isUnfinished(joined) ? 'hold' : 'settle', text: joined };
};
