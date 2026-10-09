import { describe, expect, it } from 'bun:test';
import { REF, idleSession, permissionAsk, run, runningSession } from '../../test/support/reduce.js';
import { COMMAND_TTL_MS, type State } from '../shared/protocol.js';
import { readGuardedCommand } from './commands.js';

const noticesOf = (state: State): string[] =>
	(state.sessions[REF]?.stream ?? []).flatMap((item) =>
		item.kind === 'notice' ? [item.text] : [],
	);

const commandAskOf = (state: State) => state.asks.find((ask) => ask.kind === 'command');

describe('readGuardedCommand', () => {
	it.each([
		['/clear', 'clear'],
		['  /CLEAR  ', 'clear'],
		['/reset', 'clear'],
		['/new', 'clear'],
		['/compact', 'compact'],
		['/compact focus on the tests', 'compact'],
		['/compact\nkeep the api notes', 'compact'],
	])('%p → %p', (text, command) => expect(readGuardedCommand(text)).toBe(command as never));

	it.each([
		'/clearly',
		'/news',
		'/ clear',
		'please /clear',
		'/clear please',
		'clear the context',
		'/compacted',
		'/help',
	])('%p → null', (text) => expect(readGuardedCommand(text)).toBeNull());
});

describe('held commands', () => {
	it('/clear on an idle session → held as a confirm, nothing sent, asked aloud', () => {
		const { state, effects } = run([{ type: 'send', ref: REF, text: '/clear' }], {
			start: idleSession(),
		});

		expect(commandAskOf(state)).toMatchObject({ ref: REF, command: 'clear', text: '/clear' });
		expect(state.sessions[REF]?.status).toBe('idle');
		expect(effects).toEqual([
			{
				type: 'speak',
				text: "Clear store/main's context? Say yes to confirm.",
				source: 'alert',
				ref: REF,
				isAsking: true,
			},
			{ type: 'expire_command', askId: commandAskOf(state)?.id ?? '' },
		]);
	});

	it('left unanswered → it lapses with a notice, and words reach the session again', () => {
		const held = run([{ type: 'send', ref: REF, text: '/clear' }], { start: idleSession() }).state;
		const askId = commandAskOf(held)?.id ?? '';
		const lapsed = run([{ type: 'command_expired', askId }], { start: held }).state;

		expect(lapsed.asks).toEqual([]);
		expect(noticesOf(lapsed)).toEqual(['The /clear went unconfirmed and was dropped.']);
		expect(
			run([{ type: 'send', ref: REF, text: 'run the tests' }], { start: lapsed }).effects,
		).toEqual([{ type: 'worker_send', ref: REF, text: 'run the tests' }]);
	});

	it('a lapse for a confirm already answered → nothing', () => {
		const idle = idleSession();

		expect(run([{ type: 'command_expired', askId: 'gone' }], { start: idle }).state.asks).toEqual(
			[],
		);
	});

	it('approved on a stopped session → it starts and gets it, without "after its current work"', () => {
		const stopped = run([{ type: 'worker_exited', ref: REF, error: null }], {
			start: idleSession(),
		}).state;
		const held = run([{ type: 'send', ref: REF, text: '/clear' }], { start: stopped }).state;
		const askId = commandAskOf(held)?.id ?? '';
		const { state, effects } = run([{ type: 'answer_command', askId, isApproved: true }], {
			start: held,
		});

		expect(effects).toEqual([{ type: 'worker_start', ref: REF, mode: 'auto' }]);
		expect(state.sessions[REF]?.queue.map((message) => message.text)).toEqual(['/clear']);
		expect(noticesOf(state)).toEqual([]);
	});

	it('a second guarded command replaces the first → one confirm, the newest', () => {
		const { state } = run(
			[
				{ type: 'send', ref: REF, text: '/clear' },
				{ type: 'send', ref: REF, text: '/compact keep the notes' },
			],
			{ start: idleSession() },
		);

		expect(state.asks.filter((ask) => ask.kind === 'command')).toHaveLength(1);
		expect(commandAskOf(state)).toMatchObject({
			command: 'compact',
			text: '/compact keep the notes',
		});
	});

	it('approved on an idle session → sent as typed, not spoken, no note', () => {
		const held = run([{ type: 'send', ref: REF, text: '/clear' }], { start: idleSession() }).state;
		const askId = commandAskOf(held)?.id ?? '';
		const { state, effects } = run([{ type: 'answer_command', askId, isApproved: true }], {
			start: held,
		});

		expect(state.asks).toEqual([]);
		expect(effects).toEqual([{ type: 'worker_send', ref: REF, text: '/clear' }]);
	});

	it('approved on a busy session → queued with a notice, and its dequeue opens no second confirm', () => {
		const held = run([{ type: 'send', ref: REF, text: '/compact' }], {
			start: runningSession(),
		}).state;
		const askId = commandAskOf(held)?.id ?? '';
		const approved = run([{ type: 'answer_command', askId, isApproved: true }], { start: held });

		expect(approved.state.sessions[REF]?.queue.map((message) => message.text)).toEqual([
			'/compact',
		]);
		expect(noticesOf(approved.state)).toEqual(['Compacts after its current work.']);

		const dequeued = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: '' }], {
			start: approved.state,
		});

		expect(dequeued.effects).toContainEqual({ type: 'worker_send', ref: REF, text: '/compact' });
		expect(commandAskOf(dequeued.state)).toBeUndefined();
	});

	it('declined → closed with a notice, nothing sent', () => {
		const held = run([{ type: 'send', ref: REF, text: '/clear' }], { start: idleSession() }).state;
		const askId = commandAskOf(held)?.id ?? '';
		const { state, effects } = run([{ type: 'answer_command', askId, isApproved: false }], {
			start: held,
		});

		expect(state.asks).toEqual([]);
		expect(effects).toEqual([]);
		expect(noticesOf(state)).toEqual(['Cancelled /clear.']);
	});

	it('approved after the TTL → dropped with a notice, nothing sent', () => {
		const held = run([{ type: 'send', ref: REF, text: '/clear' }], { start: idleSession() }).state;
		const askId = commandAskOf(held)?.id ?? '';
		const { state, effects } = run([{ type: 'answer_command', askId, isApproved: true }], {
			start: held,
			at: 1000 + COMMAND_TTL_MS + 100,
		});

		expect(effects).toEqual([]);
		expect(state.asks).toEqual([]);
		expect(noticesOf(state)[0]).toContain('waited too long');
	});

	it('beside an open permission → refused with a notice, no second ask', () => {
		const waiting = run([{ type: 'ask_opened', ask: permissionAsk('p1') }], {
			start: runningSession(),
		}).state;
		const { state, effects } = run([{ type: 'send', ref: REF, text: '/clear' }], {
			start: waiting,
		});

		expect(state.asks.map((ask) => ask.id)).toEqual(['p1']);
		expect(effects).toEqual([]);
		expect(noticesOf(state)).toEqual(['/clear not sent: answer what it is waiting on first.']);
	});

	it('a permission opening while it is held → the confirm is cancelled, so "yes" cannot land on it', () => {
		const held = run([{ type: 'send', ref: REF, text: '/clear' }], {
			start: runningSession(),
		}).state;
		const { state } = run([{ type: 'ask_opened', ask: permissionAsk('p1') }], { start: held });

		expect(state.asks.map((ask) => ask.id)).toEqual(['p1']);
		expect(noticesOf(state)).toEqual(['Cancelled /clear.']);
	});

	it('closing a permission while a confirm is held → the session runs again, not stuck blocked', () => {
		const blocked = run(
			[
				{ type: 'ask_opened', ask: permissionAsk('p1') },
				{ type: 'answer_permission', askId: 'p1', decision: 'allow' },
				{ type: 'send', ref: REF, text: '/clear' },
			],
			{ start: runningSession() },
		).state;

		expect(blocked.sessions[REF]?.status).toBe('running');
		expect(commandAskOf(blocked)).toBeDefined();
	});

	it('other words while it is held → cancelled, and the words go to the session', () => {
		const held = run([{ type: 'send', ref: REF, text: '/clear' }], { start: idleSession() }).state;
		const { state, effects } = run([{ type: 'send', ref: REF, text: 'run the tests first' }], {
			start: held,
		});

		expect(state.asks).toEqual([]);
		expect(noticesOf(state)).toEqual(['Cancelled /clear.']);
		expect(effects).toEqual([{ type: 'worker_send', ref: REF, text: 'run the tests first' }]);
	});

	it('deactivating the session → the confirm closes without resolving anything with the SDK', () => {
		const held = run([{ type: 'send', ref: REF, text: '/clear' }], { start: idleSession() }).state;
		const { state, effects } = run([{ type: 'deactivate', ref: REF }], { start: held });

		expect(state.asks).toEqual([]);
		expect(effects).toEqual([
			{ type: 'drop_speech', ref: REF, before: Number.MAX_SAFE_INTEGER },
			{ type: 'worker_stop', ref: REF },
		]);
	});
});
