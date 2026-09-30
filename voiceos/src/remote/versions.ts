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
