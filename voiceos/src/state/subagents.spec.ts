import { describe, expect, it } from 'bun:test';
import { REF, run, runningSession } from '../../test/support/reduce.js';
import type { Input, State } from '../shared/protocol.js';

const started = (taskId: string, isBackground = false): Input => ({
	type: 'subagent_started',
	ref: REF,
	taskId,
	agentType: 'Explore',
	description: 'find the router',
	isBackground,
});

const subagentsOf = (state: State) => state.sessions[REF]?.subagents ?? [];

describe('sub-agents', () => {
	it('started → a row with its type, description and start time, no step yet', () => {
		const { state } = run([started('t1')], { start: runningSession(), at: 5000 });

		expect(subagentsOf(state)).toEqual([
			{
				taskId: 't1',
				agentType: 'Explore',
				description: 'find the router',
				startedAt: 5000,
				step: null,
				isBackground: false,
			},
		]);
	});

	it('started twice → one row, keeping when it first started', () => {
		const { state } = run([started('t1'), started('t1')], { start: runningSession(), at: 5000 });

		expect(subagentsOf(state).map((subagent) => subagent.startedAt)).toEqual([5000]);
	});

	it('a step → its row shows it; a step for an unknown task changes nothing', () => {
		const { state } = run(
			[
				started('t1'),
				{ type: 'subagent_step', ref: REF, taskId: 't1', step: 'read router.ts' },
				{ type: 'subagent_step', ref: REF, taskId: 'nope', step: 'run ls' },
			],
			{ start: runningSession() },
		);

		expect(subagentsOf(state).map((subagent) => subagent.step)).toEqual(['read router.ts']);
	});

	it('ended → its row goes; an unknown task ending changes nothing', () => {
		const { state } = run(
			[
				started('t1'),
				started('t2'),
				{ type: 'subagent_ended', ref: REF, taskId: 't1' },
				{ type: 'subagent_ended', ref: REF, taskId: 'nope' },
			],
			{ start: runningSession() },
		);

		expect(subagentsOf(state).map((subagent) => subagent.taskId)).toEqual(['t2']);
	});

	it('the turn ends → foreground rows go, background ones stay', () => {
		const { state } = run(
			[
				started('fg'),
				started('bg', true),
				started('moved'),
				{ type: 'subagent_backgrounded', ref: REF, taskId: 'moved' },
				{ type: 'turn_ended', ref: REF, costUsd: 0, text: '' },
			],
			{ start: runningSession() },
		);

		expect(subagentsOf(state).map((subagent) => subagent.taskId)).toEqual(['bg', 'moved']);
	});

	it('the conversation is cleared → a notice, and the next message carries Voice OS context again', () => {
		const { state } = run([{ type: 'conversation_reset', ref: REF }], { start: runningSession() });
		const session = state.sessions[REF];

		expect(session?.isFresh).toBe(true);
		expect(session?.stream.at(-1)).toMatchObject({ kind: 'notice', text: 'Context cleared.' });
	});

	it.each<[string, Input]>([
		['the process exits', { type: 'worker_exited', ref: REF, error: null }],
		['a new process starts', { type: 'session_started', ref: REF }],
		['the conversation is cleared', { type: 'conversation_reset', ref: REF }],
	])('%s → every row goes', (_, input) => {
		const { state } = run([started('bg', true), input], { start: runningSession() });

		expect(subagentsOf(state)).toEqual([]);
	});
});
