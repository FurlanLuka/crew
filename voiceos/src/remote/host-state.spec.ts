import { describe, expect, it } from 'bun:test';
import {
	acceptEffects,
	buildSnapshot,
	createHostState,
	isBusy,
	openInbox,
	trackEffect,
	trackObservation,
} from './host-state.js';
import type { Observation } from '../shared/protocol.js';

const send = (seq: number) => ({
	seq,
	effect: { type: 'worker_send' as const, ref: 'a/b', text: `m${seq}` },
});

describe('inbox', () => {
	it('effects past the last applied → taken in order; earlier ones skipped', () => {
		const inbox = { mainId: 'm', runId: 'r', lastSeq: 2 };
		const accepted = acceptEffects(inbox, [send(3), send(2), send(4)]);

		expect(accepted.effects.map((effect) => effect.type === 'worker_send' && effect.text)).toEqual([
			'm3',
			'm4',
		]);
		expect(accepted.inbox.lastSeq).toBe(4);
	});

	it('the same main process again → keeps counting', () => {
		expect(openInbox({ mainId: 'm', runId: 'r', lastSeq: 7 }, 'm', 'r').lastSeq).toBe(7);
	});

	it('a restarted main (new runId) → counts from 1 again', () => {
		expect(openInbox({ mainId: 'm', runId: 'r', lastSeq: 7 }, 'm', 'r2').lastSeq).toBe(0);
	});
});

describe('host state', () => {
	it('a turn → running, then idle with its last turn kept', () => {
		let state = trackEffect(createHostState(), { type: 'worker_start', ref: 'a/b', mode: 'auto' });

		state = trackObservation(state, { type: 'session_started', ref: 'a/b' });
		state = trackObservation(state, { type: 'turn_started', ref: 'a/b' });
		expect(isBusy(state)).toBe(true);

		state = trackObservation(state, {
			type: 'turn_ended',
			ref: 'a/b',
			costUsd: 1,
			text: 'Done.',
			turnId: 'x-1',
			head: 'abc',
		});

		expect(isBusy(state)).toBe(false);
		expect(buildSnapshot(state, []).sessions).toEqual([
			{
				ref: 'a/b',
				status: 'idle',
				lastTurn: { id: 'x-1', text: 'Done.', costUsd: 1, head: 'abc' },
			},
		]);
	});

	it('asks and asides in flight → in the snapshot until settled', () => {
		let state = trackObservation(createHostState(), {
			type: 'ask_opened',
			ask: { id: 'k', ref: 'a/b', at: 1, kind: 'plan', input: {}, plan: 'p' },
		});

		state = trackEffect(state, { type: 'side_answer', ref: 'a/b', itemId: 'i1', question: 'q' });
		expect(buildSnapshot(state, []).asks.map((ask) => ask.id)).toEqual(['k']);
		expect(buildSnapshot(state, []).asides).toEqual([{ ref: 'a/b', itemId: 'i1' }]);

		state = trackObservation(state, { type: 'ask_closed', askId: 'k' });
		state = trackObservation(state, {
			type: 'aside_settled',
			ref: 'a/b',
			itemId: 'i1',
			question: 'q',
			status: 'answered',
			answer: 'a',
		});
		expect(buildSnapshot(state, []).asks).toEqual([]);
		expect(buildSnapshot(state, []).asides).toEqual([]);
	});

	it('a stopped session → out of the snapshot', () => {
		let state = trackObservation(createHostState(), { type: 'session_started', ref: 'a/b' });

		state = trackObservation(state, { type: 'worker_exited', ref: 'a/b', error: null });
		expect(buildSnapshot(state, []).sessions).toEqual([]);
	});
});

describe('a message taken', () => {
	it('an idle session given words → working at once, before its own report of it', () => {
		let state = trackObservation(createHostState(), { type: 'session_started', ref: 'a/b' });

		state = trackEffect(state, { type: 'worker_send', ref: 'a/b', text: 'go' });

		expect(buildSnapshot(state, []).sessions[0]?.status).toBe('running');
	});
});

describe("a session's commands on the remote", () => {
	it('kept through its turns and given in the snapshot', () => {
		const REVIEW = { name: 'review', description: 'Review a change', argumentHint: '<pr>' };
		const observations: Observation[] = [
			{ type: 'session_started', ref: 'store/main' },
			{ type: 'commands_listed', ref: 'store/main', commands: [REVIEW] },
			{ type: 'turn_started', ref: 'store/main' },
			{ type: 'turn_ended', ref: 'store/main', costUsd: 0, text: 'ok', turnId: 't1' },
		];
		const state = observations.reduce(trackObservation, createHostState());

		expect(buildSnapshot(state, []).sessions).toEqual([
			{
				ref: 'store/main',
				status: 'idle',
				lastTurn: { id: 't1', text: 'ok', costUsd: 0, head: null },
				commands: [REVIEW],
			},
		]);
	});
});

describe("a session's context reading on the remote", () => {
	it('kept beside its commands and given in the snapshot; a clear drops it', () => {
		const REVIEW = { name: 'review', description: 'Review a change', argumentHint: '<pr>' };
		const read: Observation[] = [
			{ type: 'session_started', ref: 'store/main' },
			{ type: 'context_usage', ref: 'store/main', used: 41_600, max: 200_000, compactAt: 167_000 },
			{ type: 'commands_listed', ref: 'store/main', commands: [REVIEW] },
		];
		const state = read.reduce(trackObservation, createHostState());

		expect(buildSnapshot(state, []).sessions[0]).toMatchObject({
			commands: [REVIEW],
			context: { used: 41_600, max: 200_000, compactAt: 167_000 },
		});

		const cleared = trackObservation(state, { type: 'conversation_reset', ref: 'store/main' });

		expect(buildSnapshot(cleared, []).sessions[0]).not.toHaveProperty('context');
		expect(buildSnapshot(cleared, []).sessions[0]).toMatchObject({ commands: [REVIEW] });
	});
});
