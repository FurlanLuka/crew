import { describe, expect, it } from 'bun:test';
import { createSession } from './reducer.js';
import { formatAge, describeWork } from './working.js';

const session = (patch: Partial<ReturnType<typeof createSession>> = {}) => ({
	...createSession({
		ref: 'x/main',
		label: 'x/main',
		branch: '',
		cwd: '/w',
		dirs: [],
		isPinned: false,
	}),
	...patch,
});

describe('formatAge', () => {
	it.each([
		[0, '0s'],
		[59_000, '59s'],
		[60_000, '1m'],
		[180_000, '3m'],
		[89 * 60_000, '89m'],
		[90 * 60_000, '2h'],
	])('%p ms → %p', (durationMs, expected) => expect(formatAge(durationMs)).toBe(expected));
});

describe('describeWork', () => {
	it('a running session: its last messages, and how long since the last one', () => {
		const runningSession = session({
			status: 'running',
			requests: [
				{ text: 'set up the wrk3 worktree', at: 0 },
				{ text: 'yes, go ahead', at: 60_000 },
			],
		});

		expect(describeWork(runningSession, 240_000)).toEqual({
			requests: ['set up the wrk3 worktree', 'yes, go ahead'],
			for: '3m',
			waitingFor: null,
		});
	});
	it('idle → no duration; waiting on the developer → how long', () => {
		const idleSession = session({
			status: 'idle',
			requests: [{ text: 'review the PR', at: 0 }],
			needsUser: { text: 'asks: push?', at: 60_000 },
		});

		expect(describeWork(idleSession, 120_000)).toEqual({
			requests: ['review the PR'],
			for: null,
			waitingFor: '1m',
		});
	});
	it('starting with a message queued → timed from the queue', () =>
		expect(
			describeWork(session({ status: 'starting', queue: [{ id: 'q', text: 'hi', at: 0 }] }), 30_000)
				.for,
		).toBe('30s'));
});
