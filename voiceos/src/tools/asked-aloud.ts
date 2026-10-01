import type { SpokenLine } from '../shared/protocol.js';
import { endsInQuestion } from '../shared/spoken.js';

// A line Voice OS asked aloud stays the likely target of a bare "yes" this long.
export const ASKED_ALOUD_MS = 2 * 60_000;

export interface FindLastAskedAloudParams {
	spoken: SpokenLine[];
	// Sessions that still wait on the developer.
	waitingRefs: string[];
	now: number;
	// When the developer began speaking: a line Voice OS started after that, they had not heard.
	heardFrom?: number;
}

export const findLastAskedAloud = ({
	spoken,
	waitingRefs,
	now,
	heardFrom = now,
}: FindLastAskedAloudParams): SpokenLine | null => {
	// The newest line about a session that still waits is what a bare "yes" most likely answers.
	const askedRefsOf = (line: SpokenLine): string[] =>
		(line.ref !== undefined ? [line.ref] : (line.toldAsks ?? []).map((told) => told.ref)).filter(
			(ref) => waitingRefs.includes(ref),
		);
	const line = spoken
		.filter(
			(candidate) =>
				candidate.isAsking &&
				askedRefsOf(candidate).length > 0 &&
				now - candidate.at <= ASKED_ALOUD_MS &&
				candidate.at < heardFrom,
		)
		.at(-1);

	if (!line) {
		return null;
	}

	// The meanwhile line may ask for two sessions at once: then it names neither, and a bare yes is
	// for no one until they say which.
	const [only, ...others] = askedRefsOf(line);

	return others.length === 0 && only !== undefined ? { ...line, ref: only } : line;
};

interface FindVoiceOsQuestionParams {
	spoken: SpokenLine[];
	now: number;
	heardFrom?: number;
}

// Voice OS's own question ("Did you mean the debug notes?"), when it is the last thing heard: a bare
// "yes" then answers Voice OS, not the session on screen. Anything heard after it, a session's line
// included, is what the words follow instead. Updates relaying sessions' asks are theirs, not this.
export const findVoiceOsQuestion = ({
	spoken,
	now,
	heardFrom = now,
}: FindVoiceOsQuestionParams): SpokenLine | null => {
	const last = spoken.filter((line) => line.at < heardFrom && !line.isUnplayed).at(-1);

	return last &&
		last.source === 'kernel' &&
		!last.isUpdate &&
		!last.toldAsks &&
		now - last.at <= ASKED_ALOUD_MS &&
		endsInQuestion(last.text)
		? last
		: null;
};

// What the developer heard shortly before they spoke: what "switch to it" and "what did it say?" mean.
export const HEARD_BEFORE_MS = 90_000;
const HEARD_BEFORE_KEPT = 3;
const HEARD_PREVIEW_CHARS = 140;
// The screen's own session is what "what did it say about…" asks about: its line is given whole, to this.
const SCREEN_LINE_CHARS = 600;

interface ListHeardBeforeParams {
	spoken: SpokenLine[];
	heardFrom: number;
}

// The sessions a heard line was about: its own, or every one the meanwhile line named.
export const readLineRefs = (line: SpokenLine): string[] =>
	line.ref !== undefined ? [line.ref] : (line.refs ?? []);

export const listHeardBefore = ({ spoken, heardFrom }: ListHeardBeforeParams): SpokenLine[] =>
	// Session lines that started playing before the developer spoke, newest few, oldest first. Voice
	// OS's own acks and replies are not what they answer.
	spoken
		.filter(
			(line) =>
				(line.ref !== undefined || line.refs !== undefined) &&
				line.source !== 'kernel' &&
				line.at < heardFrom &&
				heardFrom - line.at <= HEARD_BEFORE_MS,
		)
		.slice(-HEARD_BEFORE_KEPT);

const describeEnding = (line: SpokenLine, heardFrom: number): string => {
	if (line.endedAt === undefined || line.endedAt > heardFrom) {
		return 'still playing when they spoke';
	}

	const seconds = Math.round((heardFrom - line.endedAt) / 1000);

	return line.isCut
		? `cut off after ${Math.round((line.endedAt - line.at) / 1000)}s, ${seconds}s before they spoke`
		: `ended ${seconds}s before they spoke`;
};

export const formatHeardBefore = (
	lines: SpokenLine[],
	heardFrom: number,
	screen: string | null = null,
): string =>
	lines.length === 0
		? '(nothing)'
		: lines
				.map((line) => {
					const limit =
						screen !== null && line.ref === screen ? SCREEN_LINE_CHARS : HEARD_PREVIEW_CHARS;
					const text = line.text.length > limit ? `${line.text.slice(0, limit)}…` : line.text;

					return `${readLineRefs(line).join(' and ')}: "${text}" (${describeEnding(line, heardFrom)})`;
				})
				.join('; ');

interface WasJustHeardAboutParams {
	spoken: SpokenLine[];
	ref: string;
	heardFrom: number;
}

// Heard about in the last moments (its own line, "checkout needs you", the meanwhile line naming it):
// "switch to it", "what did it change?" mean that session.
export const wasJustHeardAbout = ({ spoken, ref, heardFrom }: WasJustHeardAboutParams): boolean =>
	listHeardBefore({ spoken, heardFrom }).some((line) => readLineRefs(line).includes(ref));
