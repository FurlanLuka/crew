import { describe, expect, it } from 'bun:test';
import type { Input, PendingAsk, SessionStatus, State } from '../shared/protocol.js';
import type { SendAck } from '../shared/ack.js';
import type { Effect } from './reducer.js';
import { decideDelivery } from './delivery.js';
import {
	idleSession,
	permissionAsk,
	REF,
	run,
	runningSession,
	worktree,
} from '../../test/support/reduce.js';

describe('decideDelivery', () => {
	it.each<[SessionStatus, 'question' | 'instruction' | undefined, string, 'send' | 'aside']>([
		['running', 'question', 'which file did you change?', 'aside'],
		['running', 'instruction', 'also run the linter', 'send'],
		['running', undefined, 'which file did you change?', 'send'],
		['running', 'instruction', 'btw, run the linter too', 'aside'],
		['running', undefined, 'By the way, which file?', 'aside'],
		['running', 'question', 'BY THE WAY what changed', 'aside'],
		['running', 'question', 'queue it: what changed?', 'send'],
		['running', 'question', 'by the way, queue it', 'aside'],
		['running', 'instruction', 'check btwn the two files', 'send'],
		['running', 'instruction', 'look at the subtweet handler', 'send'],
		['idle', 'question', 'by the way, which file?', 'send'],
		['blocked', 'question', 'which file?', 'aside'],
		['blocked', 'instruction', 'use the new table instead', 'send'],
		['starting', 'question', 'which file?', 'send'],
		['stopped', 'question', 'btw which file?', 'send'],
	])('%s, %s, %p → %s', (status, kind, utterance, delivery) =>
		expect(decideDelivery({ status, kind, utterance })).toBe(delivery),
	);
});

describe('the ack spoken for a send', () => {
	const LOGS: SendAck = { task: 'Checking the logs', kind: 'instruction' };
	const TESTS: SendAck = { task: 'Running the tests', kind: 'instruction' };
	const LINT: SendAck = { task: 'Running the linter', kind: 'instruction' };
	const send = (ack: SendAck, patch: Partial<Extract<Input, { type: 'send' }>> = {}): Input => ({
		type: 'send',
		ref: REF,
		text: 'check the logs',
		ack,
		...patch,
	});
	const acks = (effects: Effect[]) =>
		effects.filter((effect) => effect.type === 'speak').map((effect) => effect.text);
	const owedOf = (state: State) => state.sessions[REF]?.reportOwed;

	it('idle → said now, named and high; the turn owes the report', () => {
		const { state, effects } = run([send(LOGS)], { start: idleSession() });

		expect(effects).toContainEqual({
			type: 'speak',
			text: 'Checking the logs.',
			source: 'kernel',
			isReply: true,
			ref: REF,
			isNamed: true,
			priority: 'high',
			isAck: true,
		});
		expect(owedOf(state)).toEqual({ tasks: ['Checking the logs'] });
	});

	it('no phrase from the kernel → "On it." and a report still owed', () => {
		const { state, effects } = run([send({ task: null, kind: 'instruction' })], {
			start: idleSession(),
		});

		expect(acks(effects)).toEqual(['On it.']);
		expect(owedOf(state)).toEqual({ tasks: [] });
	});

	it('busy → queued behind its work; the queued message carries the promise', () => {
		const { state, effects } = run([send(LOGS)], { start: runningSession() });

		expect(acks(effects)).toEqual(['Checking the logs, after its current work.']);
		expect(state.sessions[REF]?.queue[0]?.reportOwed).toEqual({ tasks: ['Checking the logs'] });
		expect(owedOf(state)).toBeNull();
	});

	it('stopped → "Starting it up, then …"', () => {
		const stopped = run([{ type: 'worktrees', worktrees: [worktree(REF)] }]).state;
		const { state, effects } = run([send(LOGS)], { start: stopped });

		expect(acks(effects)).toEqual(['Starting it up, then checking the logs.']);
		expect(state.sessions[REF]?.queue[0]?.reportOwed).toEqual({ tasks: ['Checking the logs'] });
	});

	it('still starting → the same "Starting it up, then …"', () => {
		const starting = run([
			{ type: 'worktrees', worktrees: [worktree(REF)] },
			{ type: 'start_session', ref: REF },
		]).state;

		expect(acks(run([send(LOGS)], { start: starting }).effects)).toEqual([
			'Starting it up, then checking the logs.',
		]);
	});

	it('a question → nothing said, nothing owed; to a stopped session only "Starting it up."', () => {
		const question: SendAck = { task: null, kind: 'question' };
		const asked = run([send(question)], { start: idleSession() });
		const stopped = run([{ type: 'worktrees', worktrees: [worktree(REF)] }]).state;
		const cold = run([send(question)], { start: stopped });

		expect(acks(asked.effects)).toEqual([]);
		expect(owedOf(asked.state)).toBeNull();
		expect(acks(cold.effects)).toEqual(['Starting it up.']);
		expect(cold.state.sessions[REF]?.queue[0]?.reportOwed).toBeUndefined();
	});

	it('a spoken follow-up → said now; it owes both tasks, the cut-off turn is not narrated', () => {
		const { state, effects } = run(
			[send(LOGS, { isSpoken: true }), send(TESTS, { text: 'and run the tests', isSpoken: true })],
			{ start: idleSession() },
		);

		expect(acks(effects)).toEqual(['Running the tests.']);
		expect(state.sessions[REF]?.queue[0]?.reportOwed).toEqual({
			tasks: ['Checking the logs', 'Running the tests'],
		});
		expect(owedOf(state)).toBeNull();

		const cut = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Looking at the logs' }], {
			start: state,
		});
		expect(cut.effects.some((effect) => effect.type === 'narrate')).toBe(false);

		const ended = run(
			[{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Tests pass; logs are clean.' }],
			{ start: cut.state },
		);
		expect(ended.effects).toContainEqual(
			expect.objectContaining({
				type: 'narrate',
				owed: { tasks: ['Checking the logs', 'Running the tests'] },
			}),
		);
	});

	it('a burst of follow-ups → merged into the waiting one; it owes every task', () => {
		const { state } = run(
			[
				send(LOGS, { isSpoken: true }),
				send(TESTS, { text: 'and run the tests', isSpoken: true }),
				send(LINT, { text: 'and the linter', isSpoken: true }),
			],
			{ start: idleSession() },
		);

		expect(state.sessions[REF]?.queue[0]?.reportOwed).toEqual({
			tasks: ['Checking the logs', 'Running the tests', 'Running the linter'],
		});
	});

	it('words said while it started, then a follow-up → one request owing all three', () => {
		const stopped = run([{ type: 'worktrees', worktrees: [worktree(REF)] }]).state;
		const started = run(
			[
				send(LOGS, { isSpoken: true }),
				send(TESTS, { text: 'and run the tests', isSpoken: true }),
				{ type: 'session_started', ref: REF },
			],
			{ start: stopped },
		).state;
		const { state } = run([send(LINT, { text: 'and the linter', isSpoken: true })], {
			start: started,
		});

		expect(state.sessions[REF]?.queue[0]?.reportOwed).toEqual({
			tasks: ['Checking the logs', 'Running the tests', 'Running the linter'],
		});
		expect(owedOf(state)).toBeNull();
	});

	it('an acked turn blocks on a permission, then words answer it → it owes both', () => {
		const acked = run([send(LOGS)], { start: idleSession() }).state;
		const blocked = run([{ type: 'ask_opened', ask: permissionAsk('a1') }], { start: acked }).state;
		const { state } = run([send(TESTS, { text: 'no, run the tests first' })], { start: blocked });

		expect(owedOf(state)).toEqual({ tasks: ['Checking the logs', 'Running the tests'] });
	});

	it('blocked, but its ask closed while the kernel thought → queued behind its work', () => {
		const blocked = run([{ type: 'ask_opened', ask: permissionAsk('a1') }], {
			start: runningSession(),
		}).state;
		const closed = { ...blocked, asks: [] };

		expect(acks(run([send(LOGS)], { start: closed }).effects)).toEqual([
			'Checking the logs, after its current work.',
		]);
	});

	it('a /clear beside an open permission → refused, no ack', () => {
		const blocked = run([{ type: 'ask_opened', ask: permissionAsk('a1') }], {
			start: runningSession(),
		}).state;
		const { state, effects } = run([send(LOGS, { text: '/clear' })], { start: blocked });

		expect(effects.some((effect) => effect.type === 'speak' && effect.isAck)).toBe(false);
		expect(owedOf(state)).toBeNull();
	});

	it('words that answer an open permission → said now, the blocked turn owes the report', () => {
		const blocked = run([{ type: 'ask_opened', ask: permissionAsk('a1') }], {
			start: runningSession(),
		}).state;
		const { state, effects } = run([send(LOGS)], { start: blocked });

		expect(acks(effects)).toEqual(['Checking the logs.']);
		expect(owedOf(state)).toEqual({ tasks: ['Checking the logs'] });
	});

	it('several questions open → shown on screen, no ack and nothing owed', () => {
		const ask: PendingAsk = {
			id: 'q1',
			ref: REF,
			at: 1,
			kind: 'question',
			input: {},
			questions: [
				{ question: 'Which table?', options: [], multiSelect: false },
				{ question: 'Which index?', options: [], multiSelect: false },
			],
		};
		const blocked = run([{ type: 'ask_opened', ask }], { start: runningSession() }).state;
		const { state, effects } = run([send(LOGS)], { start: blocked });

		expect(acks(effects)).not.toContain('Checking the logs.');
		expect(owedOf(state)).toBeNull();
	});

	it('a /clear → held for its own confirm, no ack', () => {
		const { state, effects } = run([send(LOGS, { text: '/clear' })], { start: idleSession() });

		expect(effects.some((effect) => effect.type === 'speak' && effect.isAck)).toBe(false);
		expect(owedOf(state)).toBeNull();
	});
});

describe('the owed report', () => {
	const LOGS: SendAck = { task: 'Checking the logs', kind: 'instruction' };
	const acked = (): State =>
		run([{ type: 'send', ref: REF, text: 'check the logs', ack: LOGS }], { start: idleSession() })
			.state;

	it('turn ends → narrated with the promise, cleared before the next queued turn starts', () => {
		const withNext = run(
			[
				{
					type: 'send',
					ref: REF,
					text: 'run the tests',
					ack: { task: 'Running the tests', kind: 'instruction' },
				},
			],
			{ start: acked() },
		).state;
		const { state, effects } = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Clean.' }], {
			start: withNext,
		});

		expect(effects).toContainEqual(
			expect.objectContaining({ type: 'narrate', owed: { tasks: ['Checking the logs'] } }),
		);
		expect(state.sessions[REF]?.reportOwed).toEqual({ tasks: ['Running the tests'] });
	});

	it('a turn that wrote nothing → still narrated', () => {
		const { effects } = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: '' }], {
			start: acked(),
		});

		expect(effects).toContainEqual(expect.objectContaining({ type: 'narrate', text: '' }));
	});

	it('nothing owed and nothing written → not narrated, as before', () => {
		const { effects } = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: '' }], {
			start: runningSession(),
		});

		expect(effects.some((effect) => effect.type === 'narrate')).toBe(false);
	});

	it('interrupted or stopped by the developer → nothing owed', () => {
		const interrupted = run([{ type: 'interrupt', ref: REF }], { start: acked() }).state;
		const stopped = run([{ type: 'stop_session', ref: REF }], { start: acked() }).state;

		expect(interrupted.sessions[REF]?.reportOwed).toBeNull();
		expect(stopped.sessions[REF]?.reportOwed).toBeNull();
	});

	it('a crash before the report → said, named', () => {
		const { state, effects } = run([{ type: 'worker_exited', ref: REF, error: 'exit 1' }], {
			start: acked(),
		});

		expect(effects).toContainEqual(
			expect.objectContaining({
				type: 'speak',
				text: 'Stopped before it finished checking the logs.',
				ref: REF,
				isNamed: true,
				priority: 'high',
				isOwed: true,
			}),
		);
		expect(state.sessions[REF]?.reportOwed).toBeNull();
	});

	it('a clean exit → nothing said, nothing owed', () => {
		const { state, effects } = run([{ type: 'worker_exited', ref: REF, error: null }], {
			start: acked(),
		});

		expect(effects).toEqual([]);
		expect(state.sessions[REF]?.reportOwed).toBeNull();
	});
});
