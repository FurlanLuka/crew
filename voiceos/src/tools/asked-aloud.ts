import type { SpokenLine } from '../shared/protocol.js';

// A line Voice OS asked aloud stays the likely target of a bare "yes" this long.
export const ASKED_ALOUD_MS = 2 * 60_000;

export interface FindLastAskedAloudParams {
	spoken: SpokenLine[];
	// Sessions that still wait on the developer.
	waitingRefs: string[];
	now: number;
}

export const findLastAskedAloud = ({
	spoken,
	waitingRefs,
	now,
}: FindLastAskedAloudParams): SpokenLine | null => {
	// The newest line about a session that still waits is what a bare "yes" most likely answers.
	return (
		spoken
			.filter(
				(line) =>
					line.isAsking &&
					line.ref !== undefined &&
					now - line.at <= ASKED_ALOUD_MS &&
					waitingRefs.includes(line.ref),
			)
			.at(-1) ?? null
	);
};
