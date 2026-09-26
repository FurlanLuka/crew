import { describe, expect, it } from 'bun:test';
import type { Input, PendingAsk, State, WorktreeInfo } from '../shared/protocol.js';
import { createInitialState, reduce, type Effect, type ReducerResult } from './reducer.js';

const worktree = (ref: string, overrides: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
	ref,
	label: ref,
	branch: 'main',
	cwd: `/work/${ref}`,
	dirs: [],
	isPinned: false,
	...overrides,
});

const run = (inputs: Input[], start: State = createInitialState()): ReducerResult => {
	// Steps through the inputs in turn, keeping the last input's effects.
	let state = start;
	let effects: Effect[] = [];

	for (const [index, input] of inputs.entries()) {
		const seq = state.seq + 1;
		const result = reduce(state, { seq, at: 1000 + index, id: `i${seq}`, input });

		state = result.state;
		effects = result.effects;
	}

	return { state, effects };
};

const suggestions = [
	{
		type: 'addRules',
		rules: [{ toolName: 'Bash', ruleContent: 'git push' }],
		behavior: 'allow',
		destination: 'localSettings',
	},
];

const permissionAsk = (id: string, ref = 'store/main'): PendingAsk => ({
	id,
	ref,
	at: 1,
	kind: 'permission',
	toolName: 'Bash',
	summary: 'run git push',
	input: { command: 'git push' },
	suggestions,
});

const idleSession = (): State =>
	run([
		{ type: 'worktrees', worktrees: [worktree('store/main'), worktree('store/wrk1')] },
		{ type: 'start_session', ref: 'store/main' },
		{ type: 'session_started', ref: 'store/main' },
	]).state;

describe('send', () => {
	it('idle session → sent immediately, recorded in the stream', () => {
		const { state, effects } = run(
			[{ type: 'send', ref: 'store/main', text: 'run the tests' }],
			idleSession(),
		);

		expect(effects).toEqual([{ type: 'worker_send', ref: 'store/main', text: 'run the tests' }]);
		expect(state.sessions['store/main']?.status).toBe('running');
		expect(state.sessions['store/main']?.stream.at(-1)).toMatchObject({
			kind: 'user',
			text: 'run the tests',
		});
	});

	it('a note rides with the message to the worker, queued or not, and never into the stream', () => {
		const now = run(
			[{ type: 'send', ref: 'store/main', text: 'check the logs', note: '(Voice OS: api died.)' }],
			idleSession(),
		);
		expect(now.effects).toEqual([
			{
				type: 'worker_send',
				ref: 'store/main',
				text: 'check the logs',
				note: '(Voice OS: api died.)',
			},
		]);
		expect(now.state.sessions['store/main']?.stream.at(-1)).toMatchObject({
			kind: 'user',
			text: 'check the logs',
		});

		const later = run(
			[
				{ type: 'send', ref: 'store/main', text: 'first' },
				{ type: 'send', ref: 'store/main', text: 'check the logs', note: '(Voice OS: api died.)' },
				{ type: 'turn_ended', ref: 'store/main', costUsd: 0, text: 'done' },
			],
			idleSession(),
		);
		expect(later.effects).toContainEqual({
			type: 'worker_send',
			ref: 'store/main',
			text: 'check the logs',
			note: '(Voice OS: api died.)',
		});
	});

	it('running session → queued, nothing sent until the turn ends', () => {
		const { state, effects } = run(
			[
				{ type: 'send', ref: 'store/main', text: 'first' },
				{ type: 'send', ref: 'store/main', text: 'second' },
			],
			idleSession(),
		);

		expect(effects).toEqual([]);
		expect(state.sessions['store/main']?.queue.map((message) => message.text)).toEqual(['second']);
	});

	it('turn ends with a queue → next message sent, removed from the queue', () => {
		const { state, effects } = run(
			[
				{ type: 'send', ref: 'store/main', text: 'first' },
				{ type: 'send', ref: 'store/main', text: 'second' },
				{ type: 'turn_ended', ref: 'store/main', costUsd: 0.01, text: 'done' },
			],
			idleSession(),
		);

		expect(effects).toContainEqual({ type: 'worker_send', ref: 'store/main', text: 'second' });
		expect(state.sessions['store/main']?.queue).toEqual([]);
		expect(state.sessions['store/main']?.status).toBe('running');
	});

	it('stopped session → worker started, message waits for session_started', () => {
		const base = run([{ type: 'worktrees', worktrees: [worktree('store/main')] }]).state;
		const queued = run([{ type: 'send', ref: 'store/main', text: 'hello' }], base);

		expect(queued.effects).toEqual([{ type: 'worker_start', ref: 'store/main' }]);
		expect(queued.state.sessions['store/main']?.status).toBe('starting');

		const started = run([{ type: 'session_started', ref: 'store/main' }], queued.state);
		expect(started.effects).toEqual([{ type: 'worker_send', ref: 'store/main', text: 'hello' }]);
	});

	it('blank text → ignored', () => {
		expect(run([{ type: 'send', ref: 'store/main', text: '   ' }], idleSession()).effects).toEqual(
			[],
		);
	});

	it('unknown ref → ignored', () => {
		expect(run([{ type: 'send', ref: 'nope/x', text: 'hi' }], idleSession()).effects).toEqual([]);
	});
});

describe('cancel_queued', () => {
	it('cancel of a message already sent → no-op, nothing else removed', () => {
		const sent = run(
			[
				{ type: 'send', ref: 'store/main', text: 'first' },
				{ type: 'send', ref: 'store/main', text: 'second' },
				{ type: 'send', ref: 'store/main', text: 'third' },
				{ type: 'turn_ended', ref: 'store/main', costUsd: 0, text: '' },
			],
			idleSession(),
		).state;
		const secondId = 'i5';
		const after = run(
			[{ type: 'cancel_queued', ref: 'store/main', queuedId: secondId }],
			sent,
		).state;

		expect(after.sessions['store/main']?.queue.map((message) => message.text)).toEqual(['third']);
	});

	it('double cancel → second is a no-op', () => {
		const queued = run(
			[
				{ type: 'send', ref: 'store/main', text: 'first' },
				{ type: 'send', ref: 'store/main', text: 'second' },
			],
			idleSession(),
		).state;
		const id = queued.sessions['store/main']?.queue[0]?.id ?? '';
		const once = run([{ type: 'cancel_queued', ref: 'store/main', queuedId: id }], queued).state;
		const twice = run([{ type: 'cancel_queued', ref: 'store/main', queuedId: id }], once).state;

		expect(twice.sessions['store/main']?.queue).toEqual([]);
	});
});

describe('asks', () => {
	const blocked = () => run([{ type: 'ask_opened', ask: permissionAsk('a1') }], idleSession());

	it('ask opened → session blocked and the question is spoken', () => {
		const { state, effects } = blocked();

		expect(state.sessions['store/main']?.status).toBe('blocked');
		expect(effects[0]).toMatchObject({ type: 'speak', source: 'alert' });
	});

	it('allow → resolves with the original input, session unblocked', () => {
		const { state, effects } = run(
			[{ type: 'answer_permission', askId: 'a1', decision: 'allow' }],
			blocked().state,
		);

		expect(effects).toEqual([
			{
				type: 'resolve_ask',
				askId: 'a1',
				result: { behavior: 'allow', updatedInput: { command: 'git push' } },
			},
		]);
		expect(state.asks).toEqual([]);
		expect(state.sessions['store/main']?.status).toBe('running');
	});

	it('always → carries the suggested allow-rules', () => {
		const { effects } = run(
			[{ type: 'answer_permission', askId: 'a1', decision: 'always' }],
			blocked().state,
		);

		expect(effects[0]).toMatchObject({
			result: { behavior: 'allow', updatedPermissions: suggestions },
		});
	});

	it('deny with a reason → the reason reaches Claude', () => {
		const { effects } = run(
			[{ type: 'answer_permission', askId: 'a1', decision: 'deny', message: 'use a new branch' }],
			blocked().state,
		);

		expect(effects[0]).toMatchObject({ result: { behavior: 'deny', message: 'use a new branch' } });
	});

	it('two tabs answer → first wins, second is a no-op', () => {
		const first = run(
			[{ type: 'answer_permission', askId: 'a1', decision: 'allow' }],
			blocked().state,
		);
		const second = run([{ type: 'answer_permission', askId: 'a1', decision: 'deny' }], first.state);

		expect(second.effects).toEqual([]);
	});

	it('answer after interrupt → no-op; the interrupt already denied it', () => {
		const interrupted = run([{ type: 'interrupt', ref: 'store/main' }], blocked().state);
		expect(interrupted.effects).toContainEqual({
			type: 'resolve_ask',
			askId: 'a1',
			result: { behavior: 'deny', message: 'The user interrupted.' },
		});
		expect(interrupted.effects).toContainEqual({ type: 'worker_interrupt', ref: 'store/main' });

		const late = run(
			[{ type: 'answer_permission', askId: 'a1', decision: 'allow' }],
			interrupted.state,
		);
		expect(late.effects).toEqual([]);
	});

	it('stop while blocked → pending ask denied, worker stopped, queue cleared', () => {
		const { state, effects } = run([{ type: 'stop_session', ref: 'store/main' }], blocked().state);

		expect(effects).toEqual([
			{
				type: 'resolve_ask',
				askId: 'a1',
				result: { behavior: 'deny', message: 'The session was stopped.' },
			},
			{ type: 'worker_stop', ref: 'store/main' },
		]);
		expect(state.asks).toEqual([]);
		expect(state.sessions['store/main']?.status).toBe('stopped');
	});

	it('question → answers merged into the tool input', () => {
		const ask: PendingAsk = {
			id: 'q1',
			ref: 'store/main',
			at: 1,
			kind: 'question',
			input: { questions: [{ question: 'Which table?', options: [] }] },
			questions: [
				{
					question: 'Which table?',
					options: [{ label: 'New' }, { label: 'Reuse' }],
					multiSelect: false,
				},
			],
		};
		const { effects } = run(
			[
				{ type: 'ask_opened', ask },
				{ type: 'answer_question', askId: 'q1', answers: { 'Which table?': 'Reuse' } },
			],
			idleSession(),
		);

		expect(effects[0]).toMatchObject({
			result: { behavior: 'allow', updatedInput: { answers: { 'Which table?': 'Reuse' } } },
		});
	});

	it('plan rejected → deny carries the requested change', () => {
		const ask: PendingAsk = {
			id: 'p1',
			ref: 'store/main',
			at: 1,
			kind: 'plan',
			input: { plan: 'x' },
			plan: 'x',
		};
		const { effects } = run(
			[
				{ type: 'ask_opened', ask },
				{ type: 'answer_plan', askId: 'p1', isApproved: false, message: 'skip step 3' },
			],
			idleSession(),
		);

		expect(effects[0]).toMatchObject({ result: { behavior: 'deny', message: 'skip step 3' } });
	});

	it('words sent while a question is open → they answer it (free text), nothing queued', () => {
		const ask: PendingAsk = {
			id: 'q1',
			ref: 'store/main',
			at: 1,
			kind: 'question',
			input: { questions: [{ question: 'Which table?', options: [] }] },
			questions: [
				{
					question: 'Which table?',
					options: [{ label: 'New' }, { label: 'Reuse' }],
					multiSelect: false,
				},
			],
		};
		const { state, effects } = run(
			[
				{ type: 'ask_opened', ask },
				{ type: 'send', ref: 'store/main', text: 'just discard it' },
			],
			idleSession(),
		);

		expect(effects[0]).toMatchObject({
			type: 'resolve_ask',
			askId: 'q1',
			result: {
				behavior: 'allow',
				updatedInput: { answers: { 'Which table?': 'just discard it' } },
			},
		});
		expect(state.asks).toEqual([]);
		expect(state.sessions['store/main']?.queue).toEqual([]);
		expect(state.sessions['store/main']?.status).toBe('running');
	});

	it('words sent while a permission or a plan waits → "no", with the words as what to do instead', () => {
		const permission = run(
			[{ type: 'send', ref: 'store/main', text: 'push to a new branch instead' }],
			blocked().state,
		);
		expect(permission.effects[0]).toMatchObject({
			result: { behavior: 'deny', message: 'push to a new branch instead' },
		});
		expect(permission.state.sessions['store/main']?.queue).toEqual([]);

		const plan: PendingAsk = {
			id: 'p1',
			ref: 'store/main',
			at: 1,
			kind: 'plan',
			input: { plan: 'x' },
			plan: 'x',
		};
		const { effects } = run(
			[
				{ type: 'ask_opened', ask: plan },
				{ type: 'send', ref: 'store/main', text: 'skip step 3' },
			],
			idleSession(),
		);
		expect(effects[0]).toMatchObject({ result: { behavior: 'deny', message: 'skip step 3' } });
	});

	it('words for another session are not taken as the answer', () => {
		const { state, effects } = run(
			[{ type: 'send', ref: 'store/wrk1', text: 'run the tests' }],
			run(
				[
					{ type: 'start_session', ref: 'store/wrk1' },
					{ type: 'session_started', ref: 'store/wrk1' },
				],
				blocked().state,
			).state,
		);
		expect(effects).toEqual([{ type: 'worker_send', ref: 'store/wrk1', text: 'run the tests' }]);
		expect(state.asks).toHaveLength(1);
	});

	it('worker exits while blocked → asks dropped, session stopped with its error', () => {
		const { state } = run(
			[{ type: 'worker_exited', ref: 'store/main', error: 'boom' }],
			blocked().state,
		);

		expect(state.asks).toEqual([]);
		expect(state.sessions['store/main']).toMatchObject({ status: 'stopped', error: 'boom' });
	});
});

describe('denials', () => {
	it('denied → recorded and announced', () => {
		const { state, effects } = run(
			[{ type: 'denied', ref: 'store/main', toolName: 'Bash', summary: 'run git push' }],
			idleSession(),
		);

		expect(state.denials).toHaveLength(1);
		expect(effects[0]).toMatchObject({
			type: 'speak',
			text: 'Auto mode blocked store/main: run git push.',
		});
	});

	it('allow it on an idle session → mode switched for one retry, retry sent', () => {
		const denied = run(
			[
				{ type: 'narration', ref: 'store/main', needsUser: true, text: 'Push it?', topic: null },
				{ type: 'denied', ref: 'store/main', toolName: 'Bash', summary: 'run git push' },
			],
			idleSession(),
		).state;
		const denialId = denied.denials[0]?.id ?? '';
		const { state, effects } = run([{ type: 'allow_denied', denialId }], denied);

		expect(effects[0]).toEqual({ type: 'worker_set_mode', ref: 'store/main', mode: 'default' });
		expect(effects[1]).toMatchObject({ type: 'worker_send', ref: 'store/main' });
		expect(state.sessions['store/main']?.modeOverride).toBe('default-once');
		// The retry is sent on the developer's behalf: it shows in the stream and clears needs_user.
		expect(state.sessions['store/main']?.stream.at(-1)).toMatchObject({
			kind: 'user',
			text: expect.stringContaining('run git push'),
		});
		expect(state.sessions['store/main']?.needsUser).toBeNull();

		const ended = run(
			[{ type: 'turn_ended', ref: 'store/main', costUsd: 0, text: 'pushed' }],
			state,
		);
		expect(ended.effects).toContainEqual({
			type: 'worker_set_mode',
			ref: 'store/main',
			mode: 'auto',
		});
		expect(ended.state.sessions['store/main']?.modeOverride).toBeNull();
	});
});

describe('turn_ended', () => {
	it('turn with text → narrate effect carries what the user asked', () => {
		const { effects } = run(
			[
				{ type: 'send', ref: 'store/main', text: 'run the tests' },
				{ type: 'turn_ended', ref: 'store/main', costUsd: 0.2, text: 'All 40 pass.' },
			],
			idleSession(),
		);

		expect(effects).toContainEqual({
			type: 'narrate',
			ref: 'store/main',
			text: 'All 40 pass.',
			asked: 'run the tests',
		});
	});

	it('cost accumulates across turns', () => {
		const { state } = run(
			[
				{ type: 'turn_ended', ref: 'store/main', costUsd: 0.1, text: '' },
				{ type: 'turn_ended', ref: 'store/main', costUsd: 0.25, text: '' },
			],
			idleSession(),
		);

		expect(state.sessions['store/main']?.costUsd).toBeCloseTo(0.35);
	});
});

describe('stream', () => {
	it('deltas build a draft; the complete block replaces it', () => {
		const { state } = run(
			[
				{ type: 'text_delta', ref: 'store/main', text: 'Hel' },
				{ type: 'text_delta', ref: 'store/main', text: 'lo' },
			],
			idleSession(),
		);
		expect(state.sessions['store/main']?.draft).toBe('Hello');

		const done = run([{ type: 'assistant_text', ref: 'store/main', text: 'Hello' }], state).state;
		expect(done.sessions['store/main']?.draft).toBe('');
		expect(done.sessions['store/main']?.stream.at(-1)).toMatchObject({
			kind: 'text',
			text: 'Hello',
		});
	});

	it('stream is capped', () => {
		const inputs: Input[] = Array.from({ length: 450 }, (_, i) => ({
			type: 'tool',
			ref: 'store/main',
			name: 'Read',
			summary: `read ${i}`,
		}));
		const { state } = run(inputs, idleSession());

		expect(state.sessions['store/main']?.stream).toHaveLength(400);
		expect(state.sessions['store/main']?.stream.at(-1)).toMatchObject({ summary: 'read 449' });
	});
});

describe('worktrees', () => {
	it('pinned sessions sort first, then by ref', () => {
		const { state } = run([
			{
				type: 'worktrees',
				worktrees: [
					worktree('store/wrk1'),
					worktree('voiceos', { isPinned: true }),
					worktree('checkout/main'),
				],
			},
		]);

		expect(state.order).toEqual(['voiceos', 'checkout/main', 'store/wrk1']);
	});

	it('a removed worktree with a live worker is kept until it exits', () => {
		const { state } = run(
			[{ type: 'worktrees', worktrees: [worktree('store/wrk1')] }],
			idleSession(),
		);

		expect(state.sessions['store/main']?.status).toBe('idle');
		expect(state.order).toContain('store/main');
	});

	it('viewing a worktree that disappears → back to the grid', () => {
		const viewing = run(
			[{ type: 'switch_view', view: { kind: 'session', ref: 'store/wrk1' } }],
			idleSession(),
		).state;
		const { state } = run([{ type: 'worktrees', worktrees: [worktree('store/main')] }], viewing);

		expect(state.view).toEqual({ kind: 'grid' });
	});
});

describe('narration', () => {
	it('needs_user → flagged with the spoken text; topic updated', () => {
		const { state } = run(
			[
				{
					type: 'narration',
					ref: 'store/main',
					needsUser: true,
					text: 'Push it?',
					topic: 'Checkout retries',
				},
			],
			idleSession(),
		);

		expect(state.sessions['store/main']?.needsUser?.text).toBe('Push it?');
		expect(state.sessions['store/main']?.topic).toBe('Checkout retries');
	});

	it('pinned topic → narrator cannot overwrite it', () => {
		const { state } = run(
			[
				{ type: 'pin_topic', ref: 'store/main', topic: 'Search ranking' },
				{
					type: 'narration',
					ref: 'store/main',
					needsUser: false,
					text: '',
					topic: 'Something else',
				},
			],
			idleSession(),
		);

		expect(state.sessions['store/main']?.topic).toBe('Search ranking');
	});

	it('sending to a session clears its needs-you flag', () => {
		const flagged = run(
			[{ type: 'narration', ref: 'store/main', needsUser: true, text: 'Push it?', topic: null }],
			idleSession(),
		).state;
		const { state } = run([{ type: 'send', ref: 'store/main', text: 'yes' }], flagged);

		expect(state.sessions['store/main']?.needsUser).toBeNull();
	});
});

describe('determinism', () => {
	it('same stamped inputs → same state (what browsers rely on)', () => {
		const inputs: Input[] = [
			{ type: 'worktrees', worktrees: [worktree('store/main')] },
			{ type: 'send', ref: 'store/main', text: 'hi' },
			{ type: 'session_started', ref: 'store/main' },
			{ type: 'assistant_text', ref: 'store/main', text: 'hello' },
		];

		expect(run(inputs).state).toEqual(run(inputs).state);
	});
});

describe('history_restored', () => {
	const restored = [
		{ id: 'h:u1', at: 1, kind: 'user' as const, text: 'run the tests' },
		{ id: 'h:a1:0', at: 2, kind: 'text' as const, text: 'All pass.' },
	];

	it('empty stream → filled with the restored items', () => {
		const { state } = run(
			[{ type: 'history_restored', ref: 'store/main', items: restored }],
			idleSession(),
		);
		expect(state.sessions['store/main']?.stream).toEqual(restored);
	});

	it('stream already has live lines → left alone', () => {
		const live = run([{ type: 'send', ref: 'store/main', text: 'hello' }], idleSession()).state;
		const { state } = run([{ type: 'history_restored', ref: 'store/main', items: restored }], live);
		expect(state.sessions['store/main']?.stream.map((item) => item.kind)).toEqual(['user']);
		expect(state.sessions['store/main']?.stream[0]).toMatchObject({ text: 'hello' });
	});

	it('second restore → ignored', () => {
		const { state } = run(
			[
				{ type: 'history_restored', ref: 'store/main', items: restored },
				{
					type: 'history_restored',
					ref: 'store/main',
					items: [{ id: 'x', at: 3, kind: 'text', text: 'other' }],
				},
			],
			idleSession(),
		);
		expect(state.sessions['store/main']?.stream).toEqual(restored);
	});

	it('other sessions untouched', () => {
		const { state } = run(
			[{ type: 'history_restored', ref: 'store/main', items: restored }],
			idleSession(),
		);
		expect(state.sessions['store/wrk1']?.stream).toEqual([]);
	});

	it('live output after a restore → appended after the restored lines', () => {
		const { state } = run(
			[
				{ type: 'history_restored', ref: 'store/main', items: restored },
				{ type: 'assistant_text', ref: 'store/main', text: 'Back again.' },
			],
			idleSession(),
		);
		expect(
			state.sessions['store/main']?.stream.map((item) =>
				item.kind === 'text' || item.kind === 'user' ? item.text : item.kind,
			),
		).toEqual(['run the tests', 'All pass.', 'Back again.']);
	});
});

describe('dev servers', () => {
	const web = (state: 'running' | 'died') => ({
		name: 'web',
		port: 3000,
		url: null,
		state,
		detail: null,
	});

	it('start → marked starting, one dev effect; the verdict clears starting', () => {
		const started = run([{ type: 'dev_start', ref: 'store/main' }], idleSession());
		expect(started.effects).toEqual([{ type: 'dev', ref: 'store/main', action: 'start' }]);
		expect(started.state.devStarting).toEqual(['store/main']);

		const settled = run(
			[{ type: 'dev_servers', ref: 'store/main', servers: [web('running')], isSettled: true }],
			started.state,
		);
		expect(settled.state.devStarting).toEqual([]);
		expect(settled.state.devServers['store/main']).toEqual([web('running')]);
	});

	it('a routine look does not end a start that is still being watched', () => {
		const started = run([{ type: 'dev_start', ref: 'store/main' }], idleSession()).state;
		const looked = run(
			[{ type: 'dev_servers', ref: 'store/main', servers: [web('running')], isSettled: false }],
			started,
		).state;
		expect(looked.devStarting).toEqual(['store/main']);
	});

	it('no servers any more → the worktree leaves the map', () => {
		const withServers = run(
			[{ type: 'dev_servers', ref: 'store/main', servers: [web('running')], isSettled: false }],
			idleSession(),
		).state;
		expect(
			run([{ type: 'dev_servers', ref: 'store/main', servers: [], isSettled: true }], withServers)
				.state.devServers,
		).toEqual({});
	});

	it('stop → servers and its offer forgotten, one dev effect', () => {
		const withOffer = run(
			[
				{ type: 'dev_servers', ref: 'store/main', servers: [web('died')], isSettled: false },
				{ type: 'dev_offer', offer: { ref: 'store/main', servers: ['web'], at: 1 } },
			],
			idleSession(),
		).state;
		const stopped = run([{ type: 'dev_stop', ref: 'store/main' }], withOffer);
		expect(stopped.effects).toEqual([{ type: 'dev', ref: 'store/main', action: 'stop' }]);
		expect(stopped.state.devServers).toEqual({});
		expect(stopped.state.devOffer).toBeNull();
	});

	it('fix → consumed once: the second has nothing to fix', () => {
		const withOffer = run(
			[{ type: 'dev_offer', offer: { ref: 'store/main', servers: ['web'], at: 1 } }],
			idleSession(),
		).state;
		const first = run([{ type: 'fix_dev', ref: 'store/main' }], withOffer);
		expect(first.effects).toEqual([{ type: 'fix_dev', ref: 'store/main', servers: ['web'] }]);
		expect(run([{ type: 'fix_dev', ref: 'store/main' }], first.state).effects).toEqual([]);
	});

	it('fix after the offer went stale → nothing: a late yes fixes nothing', () => {
		const withOffer = run(
			[
				{
					type: 'dev_offer',
					offer: { ref: 'store/main', servers: ['web'], at: 1000 - 3 * 60_000 },
				},
			],
			idleSession(),
		).state;
		expect(run([{ type: 'fix_dev', ref: 'store/main' }], withOffer).effects).toEqual([]);
	});

	it('fix for a worktree the offer is not about → nothing', () => {
		const withOffer = run(
			[{ type: 'dev_offer', offer: { ref: 'store/main', servers: ['web'], at: 1 } }],
			idleSession(),
		).state;
		expect(run([{ type: 'fix_dev', ref: 'store/wrk1' }], withOffer).effects).toEqual([]);
	});

	it('unknown worktree → start and stop ignored', () => {
		expect(run([{ type: 'dev_start', ref: 'nope/main' }], idleSession()).effects).toEqual([]);
		expect(run([{ type: 'dev_stop', ref: 'nope/main' }], idleSession()).effects).toEqual([]);
	});
});

describe('spoken follow-ups', () => {
	interface TimedRunResult {
		state: State;
		effects: Effect[][];
	}

	const runAtTimes = (inputs: [number, Input][], start: State): TimedRunResult => {
		// Each input at its own time: the 60 s window is what is being tested.
		let state = start;
		const effects: Effect[][] = [];

		for (const [time, input] of inputs) {
			const result = reduce(state, {
				seq: state.seq + 1,
				at: time,
				id: `i${state.seq + 1}`,
				input,
			});

			state = result.state;
			effects.push(result.effects);
		}

		return { state, effects };
	};

	const said = (text: string): Input => ({ type: 'send', ref: 'store/main', text, isSpoken: true });
	const typed = (text: string): Input => ({ type: 'send', ref: 'store/main', text });
	const ended: Input = {
		type: 'turn_ended',
		ref: 'store/main',
		costUsd: 0,
		text: 'I was halfway through…',
	};

	it('said again while the reply it started is running → the reply is interrupted; the words wait at the head', () => {
		const { state, effects } = runAtTimes(
			[
				[1000, said('run the tests')],
				[11_000, said('only the checkout ones')],
			],
			idleSession(),
		);
		expect(effects[1]).toEqual([
			{ type: 'worker_interrupt', ref: 'store/main', reason: 'follow-up' },
		]);
		expect(state.sessions['store/main']?.queue).toEqual([
			{ id: 'i5', text: 'only the checkout ones', at: 11_000, isFollowUp: true },
		]);
	});

	it('more said before the reply stops → joined to the same message, one interrupt; sent once when the turn ends', () => {
		const { state, effects } = runAtTimes(
			[
				[1000, said('run the tests')],
				[5000, said('only the checkout ones')],
				[6000, said('and skip the slow ones')],
				[7000, ended],
			],
			idleSession(),
		);
		expect(effects[2]).toEqual([]);
		expect(effects[3]).toEqual([
			{
				type: 'worker_send',
				ref: 'store/main',
				text: 'only the checkout ones and skip the slow ones',
			},
		]);
		expect(state.sessions['store/main']?.queue).toEqual([]);
		expect(
			state.sessions['store/main']?.stream
				.filter((item) => item.kind === 'user')
				.map((item) => (item.kind === 'user' ? item.text : '')),
		).toEqual(['run the tests', 'only the checkout ones and skip the slow ones']);
	});

	it('the cut-off reply is not narrated; the follow-up turn then is', () => {
		const { effects } = runAtTimes(
			[
				[1000, said('run the tests')],
				[5000, said('only checkout')],
				[6000, ended],
				[9000, ended],
			],
			idleSession(),
		);
		expect(effects[2]?.some((effect) => effect.type === 'narrate')).toBe(false);
		expect(effects[3]?.some((effect) => effect.type === 'narrate')).toBe(true);
	});

	it('the follow-up turn is itself spoken: more words soon after interrupt it too', () => {
		const { effects } = runAtTimes(
			[
				[1000, said('a')],
				[5000, said('b')],
				[6000, ended],
				[8000, said('c')],
			],
			idleSession(),
		);
		expect(effects[3]).toEqual([
			{ type: 'worker_interrupt', ref: 'store/main', reason: 'follow-up' },
		]);
	});

	it('under 60 s after → a follow-up; at 60 s → queued behind the reply', () => {
		expect(
			runAtTimes(
				[
					[1000, said('a')],
					[60_999, said('b')],
				],
				idleSession(),
			).effects[1],
		).toEqual([{ type: 'worker_interrupt', ref: 'store/main', reason: 'follow-up' }]);
		const late = runAtTimes(
			[
				[1000, said('a')],
				[61_000, said('b')],
			],
			idleSession(),
		);
		expect(late.effects[1]).toEqual([]);
		expect(late.state.sessions['store/main']?.queue).toEqual([{ id: 'i5', text: 'b', at: 61_000 }]);
	});

	it('a reply started by typing is never interrupted by speech; typing never interrupts', () => {
		expect(
			runAtTimes(
				[
					[1000, typed('a')],
					[2000, said('b')],
				],
				idleSession(),
			).effects[1],
		).toEqual([]);
		expect(
			runAtTimes(
				[
					[1000, said('a')],
					[2000, typed('b')],
				],
				idleSession(),
			).effects[1],
		).toEqual([]);
	});

	it('a follow-up already waiting takes the rest even past the 60 s mark: one message, one interrupt', () => {
		const { state, effects } = runAtTimes(
			[
				[1000, said('a')],
				[56_000, said('b')],
				[62_000, said('c')],
			],
			idleSession(),
		);
		expect(effects[2]).toEqual([]);
		expect(state.sessions['store/main']?.queue.map((message) => message.text)).toEqual(['b c']);
	});

	it('words queued behind a long task are not a follow-up when they are finally sent: that reply cannot be cut', () => {
		const { effects } = runAtTimes(
			[
				[1000, said('a')],
				[90_000, said('b')],
				[100_000, ended],
				[101_000, said('c')],
			],
			idleSession(),
		);
		expect(effects[2]).toContainEqual({ type: 'worker_send', ref: 'store/main', text: 'b' });
		expect(effects[3]).toEqual([]);
	});

	it('Stop while a follow-up waits → it is dropped with the rest of the queue; nothing is sent after', () => {
		const { state, effects } = runAtTimes(
			[
				[1000, said('a')],
				[2000, said('b')],
				[2500, { type: 'interrupt', ref: 'store/main' }],
				[3000, ended],
			],
			idleSession(),
		);
		expect(effects[3]?.filter((effect) => effect.type === 'worker_send')).toEqual([]);
		expect(state.sessions['store/main']?.voiceTurnAt).toBeNull();
	});

	it('the worker crashes while a follow-up waits → it is sent once the session is back', () => {
		const { effects } = runAtTimes(
			[
				[1000, said('a')],
				[2000, said('b')],
				[3000, { type: 'worker_exited', ref: 'store/main', error: 'boom' }],
				[4000, { type: 'send', ref: 'store/main', text: 'c', isSpoken: true }],
				[5000, { type: 'session_started', ref: 'store/main' }],
			],
			idleSession(),
		);
		expect(effects.flat().filter((effect) => effect.type === 'worker_send')).toContainEqual({
			type: 'worker_send',
			ref: 'store/main',
			text: 'b',
		});
	});

	it('no voice turn is recorded as running once it is stopped, interrupted or the worker exits', () => {
		for (const end of [
			{ type: 'interrupt', ref: 'store/main' },
			{ type: 'stop_session', ref: 'store/main' },
			{ type: 'worker_exited', ref: 'store/main', error: null },
		] as Input[]) {
			expect(
				runAtTimes(
					[
						[1000, said('a')],
						[2000, end],
					],
					idleSession(),
				).state.sessions['store/main']?.voiceTurnAt,
			).toBeNull();
		}
	});

	it('a follow-up goes ahead of typed messages already waiting; they follow it', () => {
		const { state, effects } = runAtTimes(
			[
				[1000, said('a')],
				[2000, typed('b')],
				[3000, said('c')],
				[4000, ended],
				[5000, ended],
			],
			idleSession(),
		);
		expect(effects[2]).toEqual([
			{ type: 'worker_interrupt', ref: 'store/main', reason: 'follow-up' },
		]);
		expect(effects[3]).toContainEqual({ type: 'worker_send', ref: 'store/main', text: 'c' });
		expect(effects[4]).toContainEqual({ type: 'worker_send', ref: 'store/main', text: 'b' });
		expect(state.sessions['store/main']?.queue).toEqual([]);
	});

	it('an extra turn_ended after the follow-up went out sends nothing twice', () => {
		const { effects } = runAtTimes(
			[
				[1000, said('a')],
				[2000, said('b')],
				[3000, said('c')],
				[4000, ended],
				[4100, ended],
			],
			idleSession(),
		);
		expect(
			effects
				.flat()
				.filter((effect) => effect.type === 'worker_send')
				.map((effect) => (effect.type === 'worker_send' ? effect.text : '')),
		).toEqual(['a', 'b c']);
	});

	it('the follow-up cancelled on screen → the reply that was cut is narrated after all, nothing sent', () => {
		const opened = runAtTimes(
			[
				[1000, said('a')],
				[2000, said('b')],
			],
			idleSession(),
		);
		const id = opened.state.sessions['store/main']?.queue[0]?.id ?? '';
		const { effects } = runAtTimes(
			[
				[2500, { type: 'cancel_queued', ref: 'store/main', queuedId: id }],
				[3000, ended],
			],
			opened.state,
		);
		expect(effects[1]?.some((effect) => effect.type === 'narrate')).toBe(true);
		expect(effects[1]?.some((effect) => effect.type === 'worker_send')).toBe(false);
	});

	// The reply may finish on its own just before the interrupt lands; the developer has still moved past it.
	it('a reply that finished on its own while a follow-up waited → not narrated either', () => {
		const { effects } = runAtTimes(
			[
				[1000, said('a')],
				[2000, said('b')],
				[
					2100,
					{ type: 'turn_ended', ref: 'store/main', costUsd: 0, text: 'All done, tests pass.' },
				],
			],
			idleSession(),
		);
		expect(effects[2]?.some((effect) => effect.type === 'narrate')).toBe(false);
	});

	it('speech while the session is still starting queues as its own message (nothing to interrupt yet)', () => {
		const stopped = run([{ type: 'worktrees', worktrees: [worktree('store/main')] }]).state;
		const { state, effects } = runAtTimes(
			[
				[1000, said('start and run the tests')],
				[2000, said('only checkout')],
			],
			stopped,
		);
		expect(effects[1]).toEqual([]);
		expect(state.sessions['store/main']?.queue.map((message) => message.text)).toEqual([
			'start and run the tests',
			'only checkout',
		]);
	});

	// Only words sent the moment they were said start an interruptible reply; words that waited in the queue do not.
	it('spoken words that waited behind a typed turn → their reply is not cut by speech later', () => {
		const { effects } = runAtTimes(
			[
				[1000, typed('a')],
				[2000, said('b')],
				[50_000, ended],
				[60_000, said('c')],
			],
			idleSession(),
		);
		expect(effects[3]).toEqual([]);
	});

	it('typed words while a follow-up waits → queued behind it, not merged, no interrupt', () => {
		const { state, effects } = runAtTimes(
			[
				[1000, said('a')],
				[2000, said('b')],
				[3000, typed('c')],
			],
			idleSession(),
		);
		expect(effects[2]).toEqual([]);
		expect(state.sessions['store/main']?.queue.map((message) => message.text)).toEqual(['b', 'c']);
	});

	// The interrupt is in flight when the session asks something: what is said next answers the ask.
	it('a permission opens while the follow-up waits → the next words answer it (a "no" carrying them)', () => {
		const { effects } = runAtTimes(
			[
				[1000, said('a')],
				[2000, said('b')],
				[2100, { type: 'ask_opened', ask: permissionAsk('p9') }],
				[3000, said('use the staging db instead')],
			],
			idleSession(),
		);
		expect(effects[3]).toContainEqual({
			type: 'resolve_ask',
			askId: 'p9',
			result: { behavior: 'deny', message: 'use the staging db instead' },
		});
	});

	// Seen in QA: the first words to a stopped session wait for it to start; their reply is still the developer's to cut.
	it('spoken to a stopped session → sent once it starts, and a follow-up soon after interrupts that reply', () => {
		const stopped = run([{ type: 'worktrees', worktrees: [worktree('store/main')] }]).state;
		const { effects } = runAtTimes(
			[
				[1000, said('list the files')],
				[2000, { type: 'session_started', ref: 'store/main' }],
				[8000, said('only the tests')],
			],
			stopped,
		);
		expect(effects[1]).toContainEqual({
			type: 'worker_send',
			ref: 'store/main',
			text: 'list the files',
		});
		expect(effects[2]).toEqual([
			{ type: 'worker_interrupt', ref: 'store/main', reason: 'follow-up' },
		]);
	});

	// Said a (session starting), b (still starting), then c during the reply to a: b and c are one request, in that order.
	it('words spoken while it started and still waiting go first in the follow-up, in the order said', () => {
		const stopped = run([{ type: 'worktrees', worktrees: [worktree('store/main')] }]).state;
		const { state, effects } = runAtTimes(
			[
				[1000, said('a')],
				[1500, said('b')],
				[2000, { type: 'session_started', ref: 'store/main' }],
				[5000, said('c')],
				[6000, ended],
				[9000, ended],
			],
			stopped,
		);
		expect(effects[3]).toEqual([
			{ type: 'worker_interrupt', ref: 'store/main', reason: 'follow-up' },
		]);
		expect(effects[4]).toContainEqual({ type: 'worker_send', ref: 'store/main', text: 'b c' });
		expect(
			effects
				.flat()
				.filter((effect) => effect.type === 'worker_send')
				.map((effect) => (effect.type === 'worker_send' ? effect.text : '')),
		).toEqual(['a', 'b c']);
		expect(state.sessions['store/main']?.queue).toEqual([]);
	});

	it('words spoken while it started go out as a spoken turn: that reply can be cut too', () => {
		const stopped = run([{ type: 'worktrees', worktrees: [worktree('store/main')] }]).state;
		const { state } = runAtTimes(
			[
				[1000, said('a')],
				[1500, said('b')],
				[2000, { type: 'session_started', ref: 'store/main' }],
				[3000, ended],
			],
			stopped,
		);
		expect(state.sessions['store/main']?.voiceTurnAt).toBe(3000);
	});

	it('a hidden note on a follow-up rides with the merged message', () => {
		const { effects } = runAtTimes(
			[
				[1000, said('a')],
				[
					2000,
					{
						type: 'send',
						ref: 'store/main',
						text: 'b',
						isSpoken: true,
						note: '(Voice OS: api died.)',
					},
				],
				[3000, ended],
			],
			idleSession(),
		);
		expect(effects[2]).toContainEqual({
			type: 'worker_send',
			ref: 'store/main',
			text: 'b',
			note: '(Voice OS: api died.)',
		});
	});
});

describe('questions are spoken without their options', () => {
	interface QuestionSpec {
		question: string;
		options: string[];
	}

	const question = (questions: QuestionSpec[]): PendingAsk => ({
		id: 'q1',
		ref: 'store/main',
		at: 1,
		kind: 'question',
		input: {},
		questions: questions.map((spec) => ({
			question: spec.question,
			multiSelect: false,
			options: spec.options.map((label) => ({ label })),
		})),
	});

	it('the question alone, then how to hear the options', () => {
		const { effects } = run(
			[
				{
					type: 'ask_opened',
					ask: question([{ question: 'Which table?', options: ['New table', 'Reuse orders'] }]),
				},
			],
			idleSession(),
		);
		expect(effects).toEqual([
			{
				type: 'speak',
				text: 'store/main asks: Which table? Answer it, or say "options".',
				source: 'alert',
				ref: 'store/main',
				isAsking: true,
			},
		]);
	});

	it('several questions → pointed to the screen: a spoken answer would settle only the first', () => {
		const ask = question([
			{ question: 'Which table?', options: ['A'] },
			{ question: 'Which index?', options: ['B'] },
		]);
		expect(run([{ type: 'ask_opened', ask }], idleSession()).effects[0]).toMatchObject({
			text: 'store/main has 2 questions for you, on screen.',
		});
	});

	it('several questions: words are pointed to the screen, the ask stays open', () => {
		const ask = question([
			{ question: 'Which table?', options: ['A', 'B'] },
			{ question: 'Which index?', options: ['C'] },
		]);
		const opened = run([{ type: 'ask_opened', ask }], idleSession()).state;
		const words = run([{ type: 'send', ref: 'store/main', text: 'the first one' }], opened);
		expect(words.effects).toEqual([
			{
				type: 'speak',
				text: 'Those questions need answering on screen.',
				source: 'kernel',
				isReply: true,
			},
		]);
		expect(words.state.asks).toHaveLength(1);
	});

	it('a question with no options → no offer to hear them', () =>
		expect(
			run(
				[
					{
						type: 'ask_opened',
						ask: question([{ question: 'What should the branch be called?', options: [] }]),
					},
				],
				idleSession(),
			).effects[0],
		).toMatchObject({
			text: 'store/main asks: What should the branch be called?',
		}));

	it('a long question is cut short', () => {
		const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
		const text = (
			run(
				[{ type: 'ask_opened', ask: question([{ question: long, options: ['A'] }]) }],
				idleSession(),
			).effects[0] as { text: string }
		).text;
		expect(text).toContain(`${Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ')}…`);
		expect(text).not.toContain('w25');
	});

	it('a long permission summary is cut short', () => {
		const base = permissionAsk('a2');
		const ask = {
			...base,
			summary: Array.from({ length: 30 }, (_, i) => `word${i}`).join(' '),
		} as PendingAsk;
		const text = (run([{ type: 'ask_opened', ask }], idleSession()).effects[0] as { text: string })
			.text;
		expect(text).toBe(
			`store/main wants to ${Array.from({ length: 15 }, (_, i) => `word${i}`).join(' ')}… Allow?`,
		);
	});
});

describe("a session's first message since it started", () => {
	it('start marks it fresh; the first message sent clears that', () => {
		const started = run([
			{ type: 'worktrees', worktrees: [worktree('store/main')] },
			{ type: 'start_session', ref: 'store/main' },
			{ type: 'session_started', ref: 'store/main' },
		]).state;
		expect(started.sessions['store/main']?.isFresh).toBe(true);
		expect(
			run([{ type: 'send', ref: 'store/main', text: 'hi' }], started).state.sessions['store/main']
				?.isFresh,
		).toBe(false);
	});

	it('a message queued while starting clears it when it goes out', () => {
		const queued = run([
			{ type: 'worktrees', worktrees: [worktree('store/main')] },
			{ type: 'send', ref: 'store/main', text: 'hi' },
		]).state;
		expect(queued.sessions['store/main']?.isFresh).toBe(true);
		expect(
			run([{ type: 'session_started', ref: 'store/main' }], queued).state.sessions['store/main']
				?.isFresh,
		).toBe(false);
	});
});

describe('voice log', () => {
	const entry = (utterance: string) => ({ utterance, did: [], reply: '', at: 1 });

	it('kept per screen, the newest eight; the grid has its own', () => {
		const inputs: Input[] = Array.from({ length: 10 }, (_, i) => ({
			type: 'voice_logged',
			screen: 'store/main',
			entry: entry(`u${i}`),
		}));
		const { state } = run(
			[...inputs, { type: 'voice_logged', screen: 'grid', entry: entry('home') }],
			idleSession(),
		);
		expect(state.voiceLog['store/main']?.map((entry) => entry.utterance)).toEqual([
			'u2',
			'u3',
			'u4',
			'u5',
			'u6',
			'u7',
			'u8',
			'u9',
		]);
		expect(state.voiceLog.grid?.map((entry) => entry.utterance)).toEqual(['home']);
	});

	it('long words and replies are clipped', () => {
		const { state } = run([
			{
				type: 'voice_logged',
				screen: 'grid',
				entry: { ...entry('x'.repeat(2000)), reply: 'y'.repeat(2000) },
			},
		]);
		expect(state.voiceLog.grid?.[0]?.utterance.length).toBeLessThanOrEqual(501);
		expect(state.voiceLog.grid?.[0]?.reply.length).toBeLessThanOrEqual(501);
	});

	it('a screen that is not a session is dropped; a worktree that goes takes its log with it, the grid stays', () => {
		const logged = run(
			[
				{ type: 'voice_logged', screen: 'nowhere/main', entry: entry('lost') },
				{ type: 'voice_logged', screen: 'store/wrk1', entry: entry('w') },
				{ type: 'voice_logged', screen: 'grid', entry: entry('g') },
			],
			idleSession(),
		).state;
		expect(Object.keys(logged.voiceLog).sort()).toEqual(['grid', 'store/wrk1']);
		const { state } = run([{ type: 'worktrees', worktrees: [worktree('store/main')] }], logged);
		expect(Object.keys(state.voiceLog)).toEqual(['grid']);
	});
});

describe('requests: what a session was last asked', () => {
	it('each message sent is recorded with its time, the last three kept', () => {
		const { state } = run(
			['one', 'two', 'three', 'four'].flatMap((text): Input[] => [
				{ type: 'send', ref: 'store/main', text },
				{ type: 'turn_ended', ref: 'store/main', costUsd: 0, text: 'ok' },
			]),
			idleSession(),
		);
		expect(state.sessions['store/main']?.requests.map((request) => request.text)).toEqual([
			'two',
			'three',
			'four',
		]);
	});

	it('queued behind a running turn → recorded only once it goes out', () => {
		const { state } = run(
			[
				{ type: 'send', ref: 'store/main', text: 'first' },
				{ type: 'send', ref: 'store/main', text: 'later' },
			],
			idleSession(),
		);
		expect(state.sessions['store/main']?.requests.map((request) => request.text)).toEqual([
			'first',
		]);
	});
});
