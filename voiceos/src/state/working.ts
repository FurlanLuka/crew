import type { Session } from '../shared/protocol.js';

export const formatAge = (durationMs: number): string => {
	const seconds = Math.max(0, Math.round(durationMs / 1000));

	if (seconds < 60) {
		return `${seconds}s`;
	}

	const minutes = Math.round(seconds / 60);

	if (minutes < 90) {
		return `${minutes}m`;
	}

	return `${Math.round(minutes / 60)}h`;
};

export interface SessionWork {
	requests: string[];
	for: string | null;
	waitingFor: string | null;
}

export const describeWork = (session: Session, now: number): SessionWork => {
	// Shared by the kernel's view and the "elsewhere" panel, so the two say the same thing.
	const isBusy =
		session.status === 'running' || session.status === 'starting' || session.status === 'blocked';
	const startedAt = session.requests.at(-1)?.at ?? session.queue[0]?.at ?? null;

	return {
		requests: session.requests.map((request) => request.text),
		for: isBusy && startedAt !== null ? formatAge(now - startedAt) : null,
		waitingFor: session.needsUser ? formatAge(now - session.needsUser.at) : null,
	};
};
