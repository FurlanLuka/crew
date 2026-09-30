import { describe, expect, it } from 'bun:test';
import type { PendingAsk } from '../shared/protocol.js';
import { describeAskForMeanwhile } from './asks.js';

const question = (text: string, header?: string): PendingAsk => ({
	id: 'q1',
	ref: 'store/main',
	at: 0,
	kind: 'question',
	input: {},
	questions: [{ question: text, multiSelect: false, options: [], ...(header ? { header } : {}) }],
});

const plan = (text: string): PendingAsk => ({
	id: 'p1',
	ref: 'store/main',
	at: 0,
	kind: 'plan',
	input: {},
	plan: text,
});

describe('describeAskForMeanwhile', () => {
	it('a permission → what the call does, told in full', () =>
		expect(
			describeAskForMeanwhile({
				id: 'a1',
				ref: 'store/main',
				at: 0,
				kind: 'permission',
				toolName: 'Bash',
				summary: 'run git push',
				input: { command: 'git push origin main' },
				suggestions: [],
			}),
		).toEqual({ phrase: 'wants to run git push', isTold: true }));

	it('a short question → itself, told; a long one → its header, only the gist', () => {
		expect(describeAskForMeanwhile(question('Postgres or SQLite?'))).toEqual({
			phrase: 'asks: Postgres or SQLite?',
			isTold: true,
		});
		expect(
			describeAskForMeanwhile(
				question(
					'Where should a workspace keep its notes when several worktrees share one checkout on disk?',
					'Notes location',
				),
			),
		).toEqual({ phrase: 'asks about Notes location', isTold: false });
	});

	it('a plan → its first heading or line, never its body; an empty plan → just that one is ready', () => {
		expect(describeAskForMeanwhile(plan('# Retry backoff with jitter\n\n1. Cap it.'))).toEqual({
			phrase: 'has a plan ready: Retry backoff with jitter',
			isTold: false,
		});
		expect(describeAskForMeanwhile(plan('\n\n'))).toEqual({
			phrase: 'has a plan ready',
			isTold: false,
		});
	});
});
