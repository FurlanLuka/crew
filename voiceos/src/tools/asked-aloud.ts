import type { SpokenLine } from '../shared/protocol.js';

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
	return (
		spoken
			.filter(
				(line) =>
					line.isAsking &&
					line.ref !== undefined &&
					now - line.at <= ASKED_ALOUD_MS &&
					line.at < heardFrom &&
					waitingRefs.includes(line.ref),
			)
			.at(-1) ?? null
	);
};

// What the developer heard shortly before they spoke is what their words most likely pick up.
export const HEARD_BEFORE_MS = 90_000;
const HEARD_BEFORE_KEPT = 3;
const HEARD_PREVIEW_CHARS = 140;

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

export const formatHeardBefore = (lines: SpokenLine[], heardFrom: number): string =>
	lines.length === 0
		? '(nothing)'
		: lines
				.map((line) => {
					const text =
						line.text.length > HEARD_PREVIEW_CHARS
							? `${line.text.slice(0, HEARD_PREVIEW_CHARS)}…`
							: line.text;

					return `${readLineRefs(line).join(' and ')}: "${text}" (${describeEnding(line, heardFrom)})`;
				})
				.join('; ');
