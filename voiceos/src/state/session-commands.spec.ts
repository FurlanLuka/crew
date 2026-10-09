import { describe, expect, it } from 'bun:test';
import type { SessionStatus } from '../shared/protocol.js';
import { createFixtureState } from '../../test/support/state.js';
import { idleSession, REF, run } from '../../test/support/reduce.js';

const REVIEW = { name: 'review', description: 'Review a change', argumentHint: '<pr>' };

describe('session commands', () => {
	it('a listed set replaces the last; a session nobody knows takes none', () => {
		const listed = run([{ type: 'commands_listed', ref: REF, commands: [REVIEW] }], {
			start: idleSession(),
		}).state;

		expect(listed.sessions[REF]?.commands).toEqual([REVIEW]);
		expect(
			run([{ type: 'commands_listed', ref: REF, commands: [] }], { start: listed }).state.sessions[
				REF
			]?.commands,
		).toEqual([]);
		expect(
			run([{ type: 'commands_listed', ref: 'nowhere/main', commands: [REVIEW] }], {
				start: idleSession(),
			}).state.sessions['nowhere/main'],
		).toBeUndefined();
	});

	it('a reload or a model for a running session → the worker does it', () => {
		const start = idleSession();

		expect(
			run([{ type: 'reload_session', ref: REF, kind: 'plugins', force: true }], { start }).effects,
		).toEqual([{ type: 'worker_reload', ref: REF, kind: 'plugins', force: true }]);
		expect(run([{ type: 'set_model', ref: REF, model: 'opus' }], { start }).effects).toEqual([
			{ type: 'worker_set_model', ref: REF, model: 'opus' },
		]);
	});

	it('a session not started → "Start the session first." and nothing sent', () => {
		const stopped = run([{ type: 'worker_exited', ref: REF, error: null }], {
			start: idleSession(),
		}).state;
		const { state, effects } = run([{ type: 'set_model', ref: REF, model: 'opus' }], {
			start: stopped,
		});

		expect(effects).toEqual([]);
		expect(state.sessions[REF]?.stream.at(-1)).toMatchObject({
			kind: 'notice',
			text: 'Start the session first.',
		});
	});

	it.each<[SessionStatus, 'runs' | string]>([
		['idle', 'runs'],
		['running', 'runs'],
		['blocked', 'runs'],
		['starting', 'Wait for the session to start.'],
		['stopped', 'Start the session first.'],
	])('%s → %s', (status, outcome) => {
		const start = createFixtureState({});
		const ref = 'store-front/main';
		const at = {
			...start,
			sessions: { ...start.sessions, [ref]: { ...start.sessions[ref], status } },
		} as typeof start;
		const { state, effects } = run([{ type: 'reload_session', ref, kind: 'skills' }], {
			start: at,
		});

		if (outcome === 'runs') {
			expect(effects).toStrictEqual([{ type: 'worker_reload', ref, kind: 'skills' }]);
		} else {
			expect(effects).toEqual([]);
			expect(state.sessions[ref]?.stream.at(-1)).toMatchObject({ kind: 'notice', text: outcome });
		}
	});
});

describe('context meter', () => {
	it("a reading → the session's context; a clear → none until the next reading", () => {
		const read = run([{ type: 'context_usage', ref: REF, used: 41_600, max: 200_000 }], {
			start: idleSession(),
		}).state;

		expect(read.sessions[REF]?.context).toEqual({ used: 41_600, max: 200_000 });
		expect(
			run([{ type: 'conversation_reset', ref: REF }], { start: read }).state.sessions[REF]?.context,
		).toBeNull();
	});
});
