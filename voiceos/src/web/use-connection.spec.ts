import { describe, expect, it } from 'bun:test';
import type { ServerMessage, Stamped } from '../shared/protocol.js';
import { createInitialState } from '../state/reducer.js';
import { applyServerMessage, shouldReloadNow } from './use-connection.js';

const createInputMessage = (seq: number, input: Record<string, unknown>): ServerMessage =>
	({
		type: 'input',
		stamped: { seq, at: 0, id: `i${seq}`, input } as unknown as Stamped,
	}) as ServerMessage;

describe('applyServerMessage', () => {
	it('the next input → applied', () => {
		const state = createInitialState();

		const applied = applyServerMessage(
			state,
			createInputMessage(state.seq + 1, { type: 'transcript', transcript: 'hello' }),
		);

		expect(applied.shouldResync).toBe(false);
		expect(applied.shouldReload).toBeUndefined();
		expect(applied.state?.seq).toBe(state.seq + 1);
	});

	it('an input this tab does not know (it predates the server) → reload, never a throw', () => {
		const state = createInitialState();

		const applied = applyServerMessage(
			state,
			createInputMessage(state.seq + 1, { type: 'added_after_this_tab_loaded' }),
		);

		expect(applied).toEqual({ state, shouldResync: true, shouldReload: true });
	});

	it('a gap in seq → resync, not reload', () => {
		const state = createInitialState();

		expect(
			applyServerMessage(state, createInputMessage(state.seq + 2, { type: 'transcript' })),
		).toEqual({ state, shouldResync: true });
	});
});

describe('shouldReloadNow', () => {
	it('never reloaded → reload', () =>
		expect(shouldReloadNow({ lastReloadAt: null, now: 1_000 })).toBe(true));
	it('reloaded within the last minute → no second reload: the same stale code would loop', () =>
		expect(shouldReloadNow({ lastReloadAt: 1_000, now: 30_000 })).toBe(false));
	it('reloaded exactly a minute ago → still no second reload', () =>
		expect(shouldReloadNow({ lastReloadAt: 1_000, now: 61_000 })).toBe(false));
	it('reloaded over a minute ago → reload again', () =>
		expect(shouldReloadNow({ lastReloadAt: 1_000, now: 62_000 })).toBe(true));
});

describe('a restarted Voice OS', () => {
	const state = createInitialState();

	it('the first snapshot → just applied', () => {
		expect(applyServerMessage(null, { type: 'snapshot', state, serverId: 'a' }, null)).toEqual({
			state,
			shouldResync: false,
		});
	});

	it('the same server again (a dropped socket) → applied, no reload', () => {
		expect(
			applyServerMessage(state, { type: 'snapshot', state, serverId: 'a' }, 'a').shouldReload,
		).toBeUndefined();
	});

	it('another server (restarted, maybe newer) → this tab reloads its page', () => {
		expect(
			applyServerMessage(state, { type: 'snapshot', state, serverId: 'b' }, 'a').shouldReload,
		).toBe(true);
	});
});
