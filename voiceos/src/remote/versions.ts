// Which side of a version mismatch needs updating. The main updates a remote that is behind by itself;
// it never downgrades one, and a build from source ('dev') has no release to update to or from.

export type VersionFix = 'update-remote' | 'update-main' | 'none';

// Every released remote refuses with this wording; a newer one also names its version as a field.
const REFUSAL_VERSION_PATTERN = /runs Voice OS (\S+) and the main /;

export const readRemoteVersion = (refusal: { version?: string; detail: string }): string | null =>
	refusal.version ?? REFUSAL_VERSION_PATTERN.exec(refusal.detail)?.[1] ?? null;

const readRelease = (version: string): number[] | null => {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);

	return match ? match.slice(1).map(Number) : null;
};

const compareReleases = (left: number[], right: number[]): number =>
	left.map((part, index) => part - (right[index] ?? 0)).find((difference) => difference !== 0) ?? 0;

export const decideVersionFix = (main: string, remote: string | null): VersionFix => {
	const mainRelease = readRelease(main);
	const remoteRelease = remote === null ? null : readRelease(remote);

	if (!mainRelease || !remoteRelease) {
		return 'none';
	}

	const order = compareReleases(remoteRelease, mainRelease);

	return order < 0 ? 'update-remote' : order > 0 ? 'update-main' : 'none';
};

// How an update this run went, per remote version it was run from.
export type UpdateOutcome = { ok: true } | { ok: false; reason: string };

export type VersionPlan =
	| { kind: 'update'; from: string }
	| { kind: 'wait'; status: 'error'; detail: string };

interface PlanVersionFixParams {
	main: string;
	remote: string | null;
	name: string;
	// The remote's own words, for a mismatch this side cannot fix.
	detail: string;
	// How this run's update from that remote version went, if it ran.
	tried: UpdateOutcome | undefined;
}

// crew update installs the latest release, which is the main's in the normal case but may be newer:
// the wording never promises the main's version.
export const planVersionFix = ({
	main,
	remote,
	name,
	detail,
	tried,
}: PlanVersionFixParams): VersionPlan => {
	const fix = decideVersionFix(main, remote);

	if (fix === 'update-main') {
		return {
			kind: 'wait',
			status: 'error',
			detail: `${name} runs Voice OS ${remote}, newer than this one (${main}): run crew update here, then crew voice restart.`,
		};
	}

	if (fix === 'none' || remote === null) {
		return { kind: 'wait', status: 'error', detail };
	}

	const outcome = tried;

	if (!outcome) {
		return { kind: 'update', from: remote };
	}

	return outcome.ok
		? {
				kind: 'wait',
				status: 'error',
				detail: `${name} is updated but still runs its old release: run crew voice remote there.`,
			}
		: { kind: 'wait', status: 'error', detail: outcome.reason };
};

// crew update exits 0 when crew itself updated but Voice OS did not: its own warning says so.
const VOICE_NOT_UPDATED = '! Voice OS was not updated';

interface ReadUpdateOutcomeParams {
	name: string;
	code: number | null;
	output: string;
	isTimedOut: boolean;
}

export const readUpdateOutcome = ({
	name,
	code,
	output,
	isTimedOut,
}: ReadUpdateOutcomeParams): UpdateOutcome => {
	const lines = output
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	const voiceLine = lines.find((line) => line.startsWith(VOICE_NOT_UPDATED));

	if (code === 0 && !voiceLine) {
		return { ok: true };
	}

	const why = isTimedOut
		? 'crew update did not finish in time'
		: (voiceLine ?? lines.at(-1) ?? `crew update exited ${code}`);

	return {
		ok: false,
		reason: `Could not update ${name}: ${why.replace(/^!\s*/, '').replace(/\.$/, '')}. Run crew update there, then crew voice remote.`,
	};
};
