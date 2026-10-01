import { describe, expect, it } from 'bun:test';
import type { Input, PendingAsk, SessionStatus, State } from '../shared/protocol.js';
import type { SendAck } from '../shared/ack.js';
import type { Effect } from './reducer.js';
import { decideDelivery, type DeliverWish, type Delivery } from './delivery.js';
import {
	idleSession,
	permissionAsk,
	REF,
	run,
	runningSession,
	worktree,
} from '../../test/support/reduce.js';

describe('decideDelivery', () => {
	it.each<[SessionStatus, 'question' | 'instruction' | undefined, string, Delivery]>([
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
		['running', 'instruction', 'ask it right now: why is the build red', 'now'],
		['running', 'question', 'ask it right now, why is the build red?', 'now'],
		['running', 'instruction', 'tell it directly to drop the cache layer', 'now'],
		['running', 'instruction', 'send this to it immediately: use the new table', 'now'],
		['running', 'instruction', 'by the way, send it right now: use the new table', 'aside'],
		['running', 'instruction', 'queue it, not right now: use the new table', 'send'],
		['running', 'question', 'is it running right now?', 'aside'],
		['running', 'instruction', 'fix it directly in the parser', 'send'],
		['running', 'instruction', 'send it now', 'send'],
		['blocked', 'question', 'ask it right now: why step 3?', 'aside'],
		['idle', 'instruction', 'ask it right now: why is the build red', 'send'],
		['stopped', 'instruction', 'ask it right now: why is the build red', 'send'],
		['running', 'instruction', 'send it now: use the new table', 'now'],
		['running', 'question', 'ask it now whether the migration ran', 'now'],
		['running', 'instruction', 'tell them the build now passes', 'send'],
		['running', 'instruction', 'tell it that now we use Postgres', 'send'],
		['running', 'question', 'ask it why tests fail now', 'aside'],
		['running', 'question', 'ask it why tests fail right now', 'aside'],
		['running', 'instruction', 'tell it that right now the tests are red', 'send'],
	])('%s, %s, %p → %s', (status, kind, utterance, delivery) =>
		expect(decideDelivery({ status, kind, utterance })).toBe(delivery),
	);
	// Spoken words: the kernel's deliver decides, and no English keyword in them is read.
	it.each<[SessionStatus, 'question' | 'instruction', DeliverWish | 'default', string, Delivery]>([
		['running', 'instruction', 'aside', 'übrigens, lint auch', 'aside'],
		['running', 'question', 'queue', 'welche Datei?', 'send'],
		['running', 'instruction', 'now', 'mach das sofort', 'now'],
		['blocked', 'instruction', 'now', 'mach das sofort', 'send'],
		['running', 'question', 'default', 'by the way, which file?', 'aside'],
		['running', 'instruction', 'default', 'by the way, run the linter', 'send'],
		['running', 'instruction', 'default', 'send it now: use the new table', 'send'],
		['idle', 'question', 'aside', 'welche Datei?', 'send'],
		['idle', 'instruction', 'now', 'mach das sofort', 'send'],
	])('spoken: %s, %s, deliver %s, %p → %s', (status, kind, wanted, utterance, delivery) =>
		expect(decideDelivery({ status, kind, utterance, wanted })).toBe(delivery),
	);
});

describe('what Voice OS says when it passes words on', () => {
	const INSTRUCTION: SendAck = { kind: 'instruction' };
	const QUESTION: SendAck = { kind: 'question' };
	const send = (ack: SendAck, patch: Partial<Extract<Input, { type: 'send' }>> = {}): Input => ({
		type: 'send',
		ref: REF,
		text: 'check the logs',
		ack,
		...patch,
	});
	const acks = (effects: Effect[]) =>
		effects.filter((effect) => effect.type === 'speak').map((effect) => effect.text);
	const isOwed = (state: State) => state.sessions[REF]?.reportOwed;
	const stoppedSession = () => run([{ type: 'worktrees', worktrees: [worktree(REF)] }]).state;

	it('idle → nothing said, the session acks itself; the turn owes a report', () => {
		const { state, effects } = run([send(INSTRUCTION)], { start: idleSession() });

		expect(acks(effects)).toEqual([]);
		expect(isOwed(state)).toBe(true);
	});

	it('busy → "after its current work", named and high; the queued message carries the promise', () => {
		const { state, effects } = run([send(INSTRUCTION)], { start: runningSession() });

		expect(effects).toContainEqual({
			type: 'speak',
			text: 'Okay, after its current work.',
			source: 'kernel',
			isReply: true,
			ref: REF,
			isNamed: true,
			priority: 'high',
			isAck: true,
		});
		expect(state.sessions[REF]?.queue[0]?.reportOwed).toBe(true);
		expect(isOwed(state)).toBe(false);
	});

	it('stopped or still starting → "Starting it up."', () => {
		const starting = run([
			{ type: 'worktrees', worktrees: [worktree(REF)] },
			{ type: 'start_session', ref: REF },
		]).state;

		expect(acks(run([send(INSTRUCTION)], { start: stoppedSession() }).effects)).toEqual([
			'Starting it up.',
		]);
		expect(acks(run([send(INSTRUCTION)], { start: starting }).effects)).toEqual([
			'Starting it up.',
		]);
	});

	it('a question → nothing said and nothing owed; to a stopped session only "Starting it up."', () => {
		const asked = run([send(QUESTION)], { start: idleSession() });
		const cold = run([send(QUESTION)], { start: stoppedSession() });

		expect(acks(asked.effects)).toEqual([]);
		expect(isOwed(asked.state)).toBe(false);
		expect(acks(cold.effects)).toEqual(['Starting it up.']);
		expect(cold.state.sessions[REF]?.queue[0]?.reportOwed).toBeUndefined();
	});

	it("a spoken follow-up → it carries the cut turn's promise; the cut-off turn is not narrated", () => {
		const { state } = run(
			[
				send(INSTRUCTION, { isSpoken: true }),
				send(INSTRUCTION, { text: 'and run the tests', isSpoken: true }),
			],
			{ start: idleSession() },
		);

		expect(state.sessions[REF]?.queue[0]?.reportOwed).toBe(true);
		expect(isOwed(state)).toBe(false);

		const cut = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Looking at the logs' }], {
			start: state,
		});
		expect(cut.effects.some((effect) => effect.type === 'narrate')).toBe(false);

		const ended = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Tests pass.' }], {
			start: cut.state,
		});
		expect(ended.effects).toContainEqual(
			expect.objectContaining({ type: 'narrate', isOwed: true }),
		);
	});

	it('a spoken follow-up while its agents run → folded into the turn: no interrupt, the agents keep running', () => {
		const { state, effects } = run(
			[
				send(INSTRUCTION, { isSpoken: true }),
				{
					type: 'subagent_started',
					ref: REF,
					taskId: 't1',
					agentType: 'reviewer',
					description: 'review the diff',
					isBackground: true,
				},
				send(INSTRUCTION, { text: 'and run the tests', isSpoken: true }),
			],
			{ start: idleSession() },
		);

		expect(effects.some((effect) => effect.type === 'worker_interrupt')).toBe(false);
		expect(effects).toContainEqual(
			expect.objectContaining({ type: 'worker_send', ref: REF, text: 'and run the tests' }),
		);
		expect(state.sessions[REF]?.subagents.map((agent) => agent.taskId)).toEqual(['t1']);
		expect(state.sessions[REF]?.queue).toEqual([]);
	});

	it('words said while it started, then a follow-up → one request that owes the report', () => {
		const started = run(
			[
				send(QUESTION, { isSpoken: true }),
				send(INSTRUCTION, { text: 'and run the tests', isSpoken: true }),
				{ type: 'session_started', ref: REF },
			],
			{ start: stoppedSession() },
		).state;
		const { state } = run([send(QUESTION, { text: 'and the linter', isSpoken: true })], {
			start: started,
		});

		expect(state.sessions[REF]?.queue[0]?.reportOwed).toBe(true);
	});

	it('words that answer an open permission → nothing said, the blocked turn owes the report', () => {
		const blocked = run([{ type: 'ask_opened', ask: permissionAsk('a1') }], {
			start: runningSession(),
		}).state;
		const { state, effects } = run([send(INSTRUCTION)], { start: blocked });

		expect(effects.some((effect) => effect.type === 'speak' && effect.isAck)).toBe(false);
		expect(isOwed(state)).toBe(true);
	});

	it('blocked, but its ask closed while the kernel thought → queued behind its work', () => {
		const blocked = run([{ type: 'ask_opened', ask: permissionAsk('a1') }], {
			start: runningSession(),
		}).state;

		expect(acks(run([send(INSTRUCTION)], { start: { ...blocked, asks: [] } }).effects)).toEqual([
			'Okay, after its current work.',
		]);
	});

	it('several questions open → answered one at a time, nothing owed until the last', () => {
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
		const first = run([send(INSTRUCTION, { text: 'orders' })], { start: blocked });
		const last = run([send(INSTRUCTION, { text: 'a partial one' })], { start: first.state });

		expect(isOwed(first.state)).toBe(false);
		expect(isOwed(last.state)).toBe(true);
		expect(last.state.asks).toEqual([]);
		expect(last.effects).toContainEqual(
			expect.objectContaining({
				type: 'resolve_ask',
				result: {
					behavior: 'allow',
					updatedInput: { answers: { 'Which table?': 'orders', 'Which index?': 'a partial one' } },
				},
			}),
		);
	});

	it('a /clear → held for its own confirm, nothing owed', () => {
		const { state, effects } = run([send(INSTRUCTION, { text: '/clear' })], {
			start: idleSession(),
		});

		expect(effects.some((effect) => effect.type === 'speak' && effect.isAck)).toBe(false);
		expect(isOwed(state)).toBe(false);
	});
});

describe("the session's own spoken lines", () => {
	const said = (effects: Effect[]) =>
		effects.filter((effect) => effect.type === 'speak').map((effect) => effect.text);
	const delta = (text: string): Input => ({ type: 'text_delta', ref: REF, text });
	// Said where the developer is looking; off screen a line is held (held-lines.spec).
	const onScreen = (state: State): State => ({ ...state, view: { kind: 'session', ref: REF } });

	it('a tag is said the moment it closes in the stream, once, named and high', () => {
		const opening = run([delta('<spoken>Checking the logs,')], {
			start: onScreen(runningSession()),
		});
		const closed = run([delta(' back shortly.</spoken>\n\nWork')], { start: opening.state });
		const more = run([delta(' continues.')], { start: closed.state });

		expect(said(opening.effects)).toEqual([]);
		expect(closed.effects).toEqual([
			{
				type: 'speak',
				text: 'Checking the logs, back shortly.',
				source: 'narrator',
				ref: REF,
				isNamed: true,
				priority: 'high',
				isOwed: true,
				isHoldable: true,
				isAnswer: true,
			},
		]);
		expect(said(more.effects)).toEqual([]);
	});

	it('the finished message → its streamed line is not said again; the page shows it without the tag', () => {
		const streamed = run([delta('<spoken>Done: three timeouts.</spoken>\nDetails.')], {
			start: onScreen(runningSession()),
		}).state;
		const { state, effects } = run(
			[
				{
					type: 'assistant_text',
					ref: REF,
					text: '<spoken>Done: three timeouts.</spoken>\nDetails.',
				},
			],
			{ start: streamed },
		);

		expect(said(effects)).toEqual([]);
		expect(state.sessions[REF]?.stream.at(-1)).toMatchObject({ kind: 'text', text: 'Details.' });
	});

	it('a message that never streamed says its line when it arrives; an ack-only message shows its words', () => {
		const { state, effects } = run(
			[{ type: 'assistant_text', ref: REF, text: '<spoken asks>Push the branch now?</spoken>' }],
			{ start: onScreen(runningSession()) },
		);

		expect(effects).toEqual([
			expect.objectContaining({ text: 'Push the branch now?', isAsking: true }),
		]);
		expect(state.sessions[REF]?.stream.at(-1)).toMatchObject({ text: 'Push the branch now?' });
	});

	it('turn ends → the final line goes to the narrator marked as said; the next turn starts fresh', () => {
		const streamed = run([delta('<spoken>Tests pass.</spoken>')], {
			start: onScreen(runningSession()),
		}).state;
		const { state, effects } = run(
			[{ type: 'turn_ended', ref: REF, costUsd: 0, text: '<spoken>Tests pass.</spoken>\nAll 40.' }],
			{ start: streamed },
		);

		expect(effects).toContainEqual(
			expect.objectContaining({
				type: 'narrate',
				spoken: { text: 'Tests pass.', isAsking: false },
				isSpokenAlready: true,
			}),
		);
		expect(state.sessions[REF]?.spokenInTurn).toEqual([]);
	});

	it('real work: ack, then the report in a later message → each said once; the report goes to the narrator as said', () => {
		const acked = run(
			[
				delta('<spoken>Checking the logs, back shortly.</spoken>'),
				{
					type: 'assistant_text',
					ref: REF,
					text: '<spoken>Checking the logs, back shortly.</spoken>',
				},
				{ type: 'tool', ref: REF, name: 'Bash', summary: 'tail logs' },
			],
			{ start: onScreen(runningSession()) },
		).state;
		const report = run(
			[delta('<spoken>Three timeouts, all from the retry worker.</spoken>\nDetails')],
			{
				start: acked,
			},
		);
		const ended = run(
			[
				{
					type: 'turn_ended',
					ref: REF,
					costUsd: 0,
					text: '<spoken>Three timeouts, all from the retry worker.</spoken>\nDetails',
				},
			],
			{ start: report.state },
		);

		expect(said(report.effects)).toEqual(['Three timeouts, all from the retry worker.']);
		expect(ended.effects).toContainEqual(
			expect.objectContaining({
				spoken: { text: 'Three timeouts, all from the retry worker.', isAsking: false },
				isSpokenAlready: true,
			}),
		);
	});

	it("a final line seen only at the turn's end → the narrator says it", () => {
		const { effects } = run(
			[
				{
					type: 'turn_ended',
					ref: REF,
					costUsd: 0,
					text: '<spoken>Pushed.</spoken>\nBranch updated.',
				},
			],
			{ start: onScreen(runningSession()) },
		);

		expect(effects).toContainEqual(
			expect.objectContaining({
				spoken: { text: 'Pushed.', isAsking: false },
				isSpokenAlready: false,
			}),
		);
	});

	it('a reply the developer is cutting with a follow-up → its lines are not said', () => {
		const cutting = run(
			[
				{
					type: 'send',
					ref: REF,
					text: 'check the logs',
					isSpoken: true,
					ack: { kind: 'instruction' },
				},
				{
					type: 'send',
					ref: REF,
					text: 'and the tests',
					isSpoken: true,
					ack: { kind: 'instruction' },
				},
			],
			{ start: onScreen(idleSession()) },
		).state;

		expect(
			said(run([delta('<spoken>Checking the logs.</spoken>')], { start: cutting }).effects),
		).toEqual([]);
		expect(
			said(
				run([{ type: 'assistant_text', ref: REF, text: '<spoken>Checking the logs.</spoken>' }], {
					start: cutting,
				}).effects,
			),
		).toEqual([]);
	});

	it('a final message with no tag → the narrator summarizes it', () => {
		const { effects } = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'All 40 pass.' }], {
			start: onScreen(runningSession()),
		});

		expect(effects).toContainEqual(
			expect.objectContaining({ type: 'narrate', spoken: null, isSpokenAlready: false }),
		);
	});
});

describe('the owed report', () => {
	const acked = (): State =>
		run([{ type: 'send', ref: REF, text: 'check the logs', ack: { kind: 'instruction' } }], {
			start: idleSession(),
		}).state;

	it('turn ends → narrated as owed, cleared before the next queued turn starts, which owes its own', () => {
		const next = (kind: 'question' | 'instruction') =>
			run([{ type: 'send', ref: REF, text: 'and then', ack: { kind } }], { start: acked() }).state;
		const end = (start: State) =>
			run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Clean.' }], { start });

		expect(end(next('question')).effects).toContainEqual(
			expect.objectContaining({ type: 'narrate', isOwed: true }),
		);
		expect(end(next('question')).state.sessions[REF]?.reportOwed).toBe(false);
		expect(end(next('instruction')).state.sessions[REF]?.reportOwed).toBe(true);
	});

	it('a burst of spoken follow-ups → merged into the waiting one, which owes the report', () => {
		const { state } = run(
			[
				{ type: 'send', ref: REF, text: 'why', isSpoken: true, ack: { kind: 'question' } },
				{ type: 'send', ref: REF, text: 'fix it', isSpoken: true, ack: { kind: 'instruction' } },
				{ type: 'send', ref: REF, text: 'and test', isSpoken: true, ack: { kind: 'question' } },
			],
			{ start: idleSession() },
		);

		expect(state.sessions[REF]?.queue).toHaveLength(1);
		expect(state.sessions[REF]?.queue[0]?.reportOwed).toBe(true);
	});

	it('merged follow-ups keep every note they carried, the same one once', () => {
		const { state } = run(
			[
				{ type: 'send', ref: REF, text: 'why', isSpoken: true },
				{ type: 'send', ref: REF, text: 'no wait', isSpoken: true, note: 'situation' },
				{ type: 'send', ref: REF, text: 'fix it', isSpoken: true, note: 'notes path' },
				{ type: 'send', ref: REF, text: 'and test', isSpoken: true, note: 'notes path' },
			],
			{ start: idleSession() },
		);

		expect(state.sessions[REF]?.queue[0]?.note).toBe('situation\n\nnotes path');
	});

	it('words queued behind the first while it starts, each with a note, then a follow-up → every note, in order', () => {
		const { state } = run(
			[
				{ type: 'send', ref: REF, text: 'first', isSpoken: true },
				{ type: 'send', ref: REF, text: 'one', isSpoken: true, note: 'a' },
				{ type: 'send', ref: REF, text: 'two', isSpoken: true, note: 'b' },
				{ type: 'session_started', ref: REF },
				{ type: 'send', ref: REF, text: 'three', isSpoken: true, note: 'c' },
			],
			{ start: run([{ type: 'worktrees', worktrees: [worktree(REF)] }]).state },
		);

		expect(state.sessions[REF]?.queue[0]).toMatchObject({
			text: 'one two three',
			note: 'a\n\nb\n\nc',
		});
	});

	it('a turn that wrote nothing → still narrated', () => {
		const { effects } = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: '' }], {
			start: acked(),
		});

		expect(effects).toContainEqual(expect.objectContaining({ type: 'narrate', text: '' }));
	});

	it('nothing owed and nothing written → not narrated', () => {
		const { effects } = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: '' }], {
			start: runningSession(),
		});

		expect(effects.some((effect) => effect.type === 'narrate')).toBe(false);
	});

	it('interrupted or stopped by the developer → nothing owed', () => {
		expect(
			run([{ type: 'interrupt', ref: REF }], { start: acked() }).state.sessions[REF]?.reportOwed,
		).toBe(false);
		expect(
			run([{ type: 'stop_session', ref: REF }], { start: acked() }).state.sessions[REF]?.reportOwed,
		).toBe(false);
	});

	it('a crash before the report → said, named; a clean exit → nothing', () => {
		const crashed = run([{ type: 'worker_exited', ref: REF, error: 'exit 1' }], { start: acked() });
		const clean = run([{ type: 'worker_exited', ref: REF, error: null }], { start: acked() });

		expect(crashed.effects).toEqual([
			expect.objectContaining({
				type: 'speak',
				text: 'Stopped before it finished.',
				ref: REF,
				isNamed: true,
				priority: 'high',
				isOwed: true,
			}),
		]);
		expect(crashed.state.sessions[REF]?.reportOwed).toBe(false);
		expect(clean.effects).toEqual([]);
	});
});

describe('speech waiting about a session', () => {
	it('spoken words to it → its older lines are dropped (idle, working, stopped); typed words drop nothing', () => {
		const stopped = run([{ type: 'worktrees', worktrees: [worktree(REF)] }]).state;

		for (const start of [idleSession(), runningSession(), stopped]) {
			const spoken = run([{ type: 'send', ref: REF, text: 'actually do X', isSpoken: true }], {
				start,
				at: 5000,
			});
			const typed = run([{ type: 'send', ref: REF, text: 'actually do X' }], { start, at: 5000 });

			expect(spoken.effects[0]).toEqual({ type: 'drop_speech', ref: REF, before: 5000 });
			expect(typed.effects.some((effect) => effect.type === 'drop_speech')).toBe(false);
		}
	});

	it('a spoken answer to what it waits on drops them too; a typed one does not', () => {
		const blocked = run([{ type: 'ask_opened', ask: permissionAsk('p1') }], {
			start: runningSession(),
		}).state;
		const spoken = run([{ type: 'send', ref: REF, text: 'no, use staging', isSpoken: true }], {
			start: blocked,
			at: 7000,
		});
		const typed = run([{ type: 'send', ref: REF, text: 'no, use staging' }], { start: blocked });

		expect(spoken.effects[0]).toEqual({ type: 'drop_speech', ref: REF, before: 7000 });
		expect(typed.effects.some((effect) => effect.type === 'drop_speech')).toBe(false);
	});
});

describe('promote_queued', () => {
	const queuedBehind = () =>
		run(
			[
				{ type: 'send', ref: REF, text: 'use proxy pair', ack: { kind: 'instruction' } },
				{ type: 'send', ref: REF, text: 'then the tests', ack: { kind: 'instruction' } },
			],
			{ start: runningSession() },
		).state;

	it('while it works → the words cut the work and go first, owed; the rest keeps its place', () => {
		const start = queuedBehind();
		const target = start.sessions[REF]?.queue[0];
		const { state, effects } = run(
			[{ type: 'promote_queued', ref: REF, queuedId: target?.id ?? '' }],
			{
				start,
			},
		);

		expect(effects).toEqual([{ type: 'worker_interrupt', ref: REF, reason: 'follow-up' }]);
		expect(state.sessions[REF]?.queue).toEqual([
			expect.objectContaining({
				id: target?.id,
				text: 'use proxy pair',
				isFollowUp: true,
				reportOwed: true,
			}),
			expect.objectContaining({ text: 'then the tests' }),
		]);
	});

	it('while its agents run → nothing is interrupted: the words go into the turn, the agents keep running', () => {
		const start = run(
			[
				{
					type: 'subagent_started',
					ref: REF,
					taskId: 't1',
					agentType: 'reviewer',
					description: 'review the diff',
					isBackground: false,
				},
			],
			{ start: queuedBehind() },
		).state;
		const target = start.sessions[REF]?.queue[0];
		const { state, effects } = run(
			[{ type: 'promote_queued', ref: REF, queuedId: target?.id ?? '' }],
			{ start },
		);

		expect(effects.some((effect) => effect.type === 'worker_interrupt')).toBe(false);
		expect(effects).toContainEqual(
			expect.objectContaining({ type: 'worker_send', ref: REF, text: 'use proxy pair' }),
		);
		expect(state.sessions[REF]?.subagents.map((agent) => agent.taskId)).toEqual(['t1']);
		expect(state.sessions[REF]?.queue.map((message) => message.text)).toEqual(['then the tests']);
		expect(state.sessions[REF]?.status).toBe('running');
	});

	it('stopped → moved to the front and the session started; an unknown id changes nothing', () => {
		const stopped = run([{ type: 'worker_exited', ref: REF, error: 'exit 1' }], {
			start: queuedBehind(),
		}).state;
		const last = stopped.sessions[REF]?.queue.at(-1);
		const { state: moved, effects } = run(
			[{ type: 'promote_queued', ref: REF, queuedId: last?.id ?? '' }],
			{ start: stopped },
		);
		const unknown = run([{ type: 'promote_queued', ref: REF, queuedId: 'nope' }], {
			start: stopped,
		});

		expect(moved.sessions[REF]?.queue.map((message) => message.text)).toEqual([
			'then the tests',
			'use proxy pair',
		]);
		expect(effects).toEqual([{ type: 'worker_start', ref: REF }]);
		expect(unknown.state.sessions[REF]).toEqual(stopped.sessions[REF]);
		expect(unknown.effects).toEqual([]);
	});
});

describe('send said to go right now', () => {
	const now: Input = {
		type: 'send',
		ref: REF,
		text: 'why is the build red?',
		ack: { kind: 'question' },
		isNow: true,
	};

	it('while it works → the running turn is replaced, not queued behind', () => {
		const { state, effects } = run([now], { start: runningSession() });

		expect(effects).toContainEqual({ type: 'worker_interrupt', ref: REF, reason: 'follow-up' });
		expect(state.sessions[REF]?.queue).toEqual([
			expect.objectContaining({ text: 'why is the build red?', isFollowUp: true }),
		]);
		expect(state.asks).toEqual([]);
	});

	it('idle → sent at once, as any words', () => {
		const { state, effects } = run([now], { start: idleSession() });

		expect(effects).toContainEqual(
			expect.objectContaining({ type: 'worker_send', ref: REF, text: 'why is the build red?' }),
		);
		expect(state.sessions[REF]?.queue).toEqual([]);
	});

	it('stopped → queued and the session started, as any words', () => {
		const stopped = run([{ type: 'worktrees', worktrees: [worktree(REF)] }]).state;
		const { state, effects } = run([now], { start: stopped });

		expect(effects).toContainEqual({ type: 'worker_start', ref: REF });
		expect(state.sessions[REF]?.queue.map((message) => message.text)).toEqual([
			'why is the build red?',
		]);
	});
});

describe('promote_all_queued', () => {
	const send = (text: string, note?: string): Input => ({
		type: 'send',
		ref: REF,
		text,
		ack: { kind: 'instruction' },
		isSpoken: true,
		...(note ? { note } : {}),
	});
	const twoQueued = () =>
		run([send('use proxy pair', 'note one'), send('then the tests', 'note two')], {
			start: runningSession(),
		}).state;
	const promoteAll: Input = { type: 'promote_all_queued', ref: REF };

	it('while it works → both, in order, cut the work as one follow-up with both notes, owed', () => {
		const start = twoQueued();
		const firstId = start.sessions[REF]?.queue[0]?.id;
		const { state, effects } = run([promoteAll], { start });

		expect(effects).toEqual([{ type: 'worker_interrupt', ref: REF, reason: 'follow-up' }]);
		expect(state.sessions[REF]?.queue).toEqual([
			{
				id: firstId ?? '',
				text: 'use proxy pair\n\nthen the tests',
				at: expect.any(Number),
				isFollowUp: true,
				note: 'note one\n\nnote two',
				reportOwed: true,
			},
		]);
	});

	it('idle with words waiting → merged at the front, in order', () => {
		const start = idleSession();
		const session = start.sessions[REF]!;
		const waiting: State = {
			...start,
			sessions: {
				...start.sessions,
				[REF]: {
					...session,
					queue: [
						{ id: 'q1', text: 'use proxy pair', at: 1 },
						{ id: 'q2', text: 'then the tests', at: 2 },
					],
				},
			},
		};
		const { state, effects } = run([promoteAll], { start: waiting });

		expect(effects).toEqual([]);
		expect(state.sessions[REF]?.queue).toEqual([
			{ id: 'q1', text: 'use proxy pair\n\nthen the tests', at: 1 },
		]);
	});

	it("stopped, with Voice OS's own retry between them → theirs merged first and started; the retry stays queued", () => {
		const stopped = run([{ type: 'worker_exited', ref: REF, error: 'exit 1' }], {
			start: twoQueued(),
		}).state;
		const [first, second] = stopped.sessions[REF]?.queue ?? [];
		const retry = { id: 'r1', text: 'The user allows this once: retry "x" now.', at: 3 };
		const withRetry: State = {
			...stopped,
			sessions: {
				...stopped.sessions,
				[REF]: {
					...stopped.sessions[REF]!,
					queue: [first!, { ...retry, isRetry: true }, second!],
				},
			},
		};
		const { state, effects } = run([promoteAll], { start: withRetry });

		expect(effects).toEqual([{ type: 'worker_start', ref: REF }]);
		expect(state.sessions[REF]?.queue.map((message) => message.text)).toEqual([
			'use proxy pair\n\nthen the tests',
			retry.text,
		]);
	});

	it('nothing of theirs waiting → nothing changes', () => {
		const start = runningSession();
		const { state, effects } = run([promoteAll], { start });

		expect(effects).toEqual([]);
		expect(state.sessions[REF]).toEqual(start.sessions[REF]);
	});

	it('take that back after the merge → the merged words are taken back', () => {
		const start = twoQueued();
		const firstId = start.sessions[REF]?.queue[0]?.id;

		expect(start.lastSpokenSend?.id).toBe(start.sessions[REF]?.queue[1]?.id ?? '');

		const merged = run([promoteAll], { start }).state;

		expect(merged.lastSpokenSend?.id).toBe(firstId ?? '');

		const { state } = run([{ type: 'take_back', ref: REF, id: merged.lastSpokenSend?.id ?? '' }], {
			start: merged,
		});

		expect(state.sessions[REF]?.queue).toEqual([]);
	});
});
