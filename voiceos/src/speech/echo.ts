import { STANDALONE_WORDS } from '../shared/spoken.js';

export interface SpokenRecord {
	text: string;
	// null while the line is still playing.
	endedAt: number | null;
}

export const ECHO_WINDOW_MS = 10_000;
const MIN_WORD_OVERLAP_RATIO = 0.8;
const MIN_FUZZY_WORDS = 4;
const SHORT_ECHO_MS = 1_500;

const splitWords = (text: string): string[] =>
	text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s']/gu, ' ')
		.split(/\s+/)
		.filter(Boolean);

const endsWithRun = (lineWords: string[], run: string[]): boolean =>
	run.length <= lineWords.length &&
	run.every((word, index) => lineWords[lineWords.length - run.length + index] === word);

const containsRun = (lineWords: string[], run: string[], isPartial: boolean): boolean => {
	const matchesAt = (word: string, index: number, start: number) =>
		lineWords[start + index] === word ||
		(isPartial && index === run.length - 1 && (lineWords[start + index] ?? '').startsWith(word));

	return lineWords.some((_, start) => run.every((word, index) => matchesAt(word, index, start)));
};

export const isRecent = (line: SpokenRecord, now: number): boolean => {
	// Room lag and a slow transcript both land after the clip ends.
	return line.endedAt === null || now - line.endedAt <= ECHO_WINDOW_MS;
};

export interface IsEchoParams {
	heard: string;
	spoken: SpokenRecord[];
	now: number;
	// Text still being heard, whose last word may be half a word.
	isPartial?: boolean;
}

export const isEcho = ({ heard, spoken, now, isPartial = false }: IsEchoParams): boolean => {
	const heardWords = splitWords(heard);

	if (heardWords.length === 0) {
		return false;
	}

	// Yes, no, stop and the like said alone are always the developer's.
	if (!isPartial && heardWords.length === 1 && STANDALONE_WORDS.has(heardWords[0] ?? '')) {
		return false;
	}

	return spoken.some((line) => {
		const msSinceEnded = line.endedAt === null ? 0 : now - line.endedAt;
		const lineWords = splitWords(line.text);

		// An answer in the line's words comes after it; its echo comes during or just after.
		// A finished short turn is echo only as the line's tail, which leaks as the line ends.
		if (heardWords.length < MIN_FUZZY_WORDS) {
			return (
				msSinceEnded <= SHORT_ECHO_MS &&
				(isPartial ? containsRun(lineWords, heardWords, true) : endsWithRun(lineWords, heardWords))
			);
		}

		if (!isRecent(line, now)) {
			return false;
		}

		const matchedCount = heardWords.filter(
			(word, index) =>
				lineWords.includes(word) ||
				(isPartial &&
					index === heardWords.length - 1 &&
					lineWords.some((lineWord) => lineWord.startsWith(word))),
		).length;

		if (matchedCount === heardWords.length) {
			return true;
		}

		// Speech recognition of played-back audio is never word-perfect.
		return matchedCount / heardWords.length >= MIN_WORD_OVERLAP_RATIO;
	});
};

export const countWords = (text: string): number => splitWords(text).length;
