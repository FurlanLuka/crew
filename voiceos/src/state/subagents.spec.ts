import { describe, expect, it } from 'bun:test';
import { REF, run, runningSession } from '../../test/support/reduce.js';
import type { Input, State, SubagentItemContent } from '../shared/protocol.js';
import {
	hasBackgroundWork,
	SUBAGENT_ITEMS_KEPT,
	SUBAGENT_RUNS_KEPT,
	SUBAGENT_TEXT_CHARS,
} from './subagents.js';

const started = (taskId: string, isBackground = false): Input => ({
	type: 'subagent_started',
	ref: REF,
	taskId,
	agentType: 'Explore',
	description: 'find the router',
	isBackground,
});

const subagentsOf = (state: State) => state.sessions[REF]?.subagents ?? [];
const runsOf = (state: State) => state.sessions[REF]?.subagentRuns ?? [];
const said = (taskId: string, item: SubagentItemContent): Input => ({
	type: 'subagent_item',
	ref: REF,
	taskId,
	item,
});
const ended = (taskId: string): Input => ({ type: 'subagent_ended', ref: REF, taskId });

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

	it('ended → its running row goes (its transcript stays); an unknown task ending changes nothing', () => {
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

describe('sub-agent transcripts', () => {
	it('started, then its text, calls and results → a run with them, ids and times from the stamps', () => {
		const { state, effects } = run(
			[
				{ ...started('t1'), toolUseId: 'toolu_1' } as Input,
				said('t1', { kind: 'text', text: 'Looking.' }),
				said('t1', { kind: 'tool', name: 'Grep', summary: 'search for route' }),
				said('t1', { kind: 'tool_result', ok: true, summary: 'router.ts:12' }),
			],
			{ start: runningSession(), at: 5000 },
		);

		expect(runsOf(state)).toEqual([
			{
				taskId: 't1',
				toolUseId: 'toolu_1',
				agentType: 'Explore',
				description: 'find the router',
				startedAt: 5000,
				items: [
					{ id: expect.any(String), at: 5001, kind: 'text', text: 'Looking.' },
					{
						id: expect.any(String),
						at: 5002,
						kind: 'tool',
						name: 'Grep',
						summary: 'search for route',
					},
					{
						id: expect.any(String),
						at: 5003,
						kind: 'tool_result',
						ok: true,
						summary: 'router.ts:12',
					},
				],
			},
		]);
		// Its words are shown, never said.
		expect(effects).toEqual([]);
	});

	it('ended → the transcript stays and counts as no work: the running list is empty', () => {
		const { state } = run(
			[started('t1', true), said('t1', { kind: 'text', text: 'Done.' }), ended('t1')],
			{
				start: runningSession(),
			},
		);

		expect(runsOf(state).map((kept) => kept.items.length)).toEqual([1]);
		expect(subagentsOf(state)).toEqual([]);
		expect(hasBackgroundWork(state.sessions[REF]!)).toBe(false);
	});

	it('started twice (a resume) → one transcript that goes on; a line for an unknown task changes nothing', () => {
		const { state } = run(
			[
				started('t1'),
				said('t1', { kind: 'text', text: 'first' }),
				started('t1'),
				said('t1', { kind: 'text', text: 'second' }),
				said('nope', { kind: 'text', text: 'lost' }),
			],
			{ start: runningSession() },
		);

		expect(
			runsOf(state).map((kept) =>
				kept.items.map((item) => (item.kind === 'text' ? item.text : '')),
			),
		).toEqual([['first', 'second']]);
	});

	it(`the ${SUBAGENT_RUNS_KEPT + 1}th → the oldest ended one goes, never one still running`, () => {
		const tasks = Array.from({ length: SUBAGENT_RUNS_KEPT + 1 }, (_, index) => `t${index}`);
		const { state } = run(
			[
				started('t0'),
				...tasks.slice(1, -1).flatMap((taskId) => [started(taskId), ended(taskId)]),
				started(tasks.at(-1)!),
			],
			{ start: runningSession() },
		);

		expect(runsOf(state).map((kept) => kept.taskId)).toEqual(['t0', ...tasks.slice(2)]);
	});

	it('more running than are kept → all kept, the newest too: a running one is never dropped', () => {
		const tasks = Array.from({ length: SUBAGENT_RUNS_KEPT + 1 }, (_, index) => `t${index}`);
		const { state } = run(
			tasks.map((taskId) => started(taskId)),
			{ start: runningSession() },
		);

		expect(runsOf(state).map((kept) => kept.taskId)).toEqual(tasks);
	});

	it(`the ${SUBAGENT_ITEMS_KEPT + 1}th line → the oldest goes; a long text is clipped`, () => {
		const { state } = run(
			[
				started('t1'),
				...Array.from({ length: SUBAGENT_ITEMS_KEPT }, (_, index) =>
					said('t1', { kind: 'tool', name: 'Read', summary: `read ${index}` }),
				),
				said('t1', { kind: 'text', text: 'x'.repeat(SUBAGENT_TEXT_CHARS + 50) }),
			],
			{ start: runningSession() },
		);
		const items = runsOf(state)[0]!.items;

		expect(items).toHaveLength(SUBAGENT_ITEMS_KEPT);
		expect(items[0]).toMatchObject({ kind: 'tool', summary: 'read 1' });
		expect(items.at(-1)).toMatchObject({
			kind: 'text',
			text: `${'x'.repeat(SUBAGENT_TEXT_CHARS)}…`,
		});
	});

	it('the worker exits and starts again (a resume, a remote reconnect) → transcripts kept', () => {
		const { state } = run(
			[
				started('t1'),
				said('t1', { kind: 'text', text: 'Looking.' }),
				{ type: 'worker_exited', ref: REF, error: null },
				{ type: 'session_started', ref: REF },
			],
			{ start: runningSession() },
		);

		expect(runsOf(state).map((kept) => kept.taskId)).toEqual(['t1']);
	});

	it('the conversation is cleared → transcripts go', () => {
		const { state } = run([started('t1'), { type: 'conversation_reset', ref: REF }], {
			start: runningSession(),
		});

		expect(runsOf(state)).toEqual([]);
	});
});
