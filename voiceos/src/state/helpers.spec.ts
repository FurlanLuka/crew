import { describe, expect, it } from 'bun:test';
import type { Input, State } from '../shared/protocol.js';
import { describeMachineWaiting, readSessionLabel } from '../shared/machines.js';
import { run, worktree } from '../../test/support/reduce.js';
import { readLabel, releaseRefs, truncateText } from './helpers.js';
import { createInitialState } from './reducer.js';
import { describeAnnouncement } from './held-lines.js';

describe('truncateText', () => {
	it('short text is kept whole', () => expect(truncateText('abc', 5)).toBe('abc'));
	it('long text is cut to the limit, marked with an ellipsis', () =>
		expect(truncateText('abcdef', 3)).toBe('abc…'));
});

describe('what a session is called', () => {
	const REMOTE = 'vm1:crew/main';
	const state = (extra: Input[] = []): State =>
		run([
			{ type: 'machines', machines: [{ id: 'vm1', host: 'vm1', name: 'Personal' }] },
			{
				type: 'worktrees',
				worktrees: [worktree('crew/main'), { ...worktree(REMOTE), label: 'crew/main' }],
			},
			{ type: 'machine_resynced', id: 'vm1', inputs: [] },
			{ type: 'switch_view', view: { kind: 'grid', machine: 'local' } },
			...extra,
		]).state;
	const named = (): State => state([{ type: 'rename_session', ref: REMOTE, name: 'voice os dev' }]);

	it("no name → crew's label; a ref crew does not have → its local ref", () => {
		expect(readSessionLabel(state(), REMOTE)).toBe('crew/main');
		expect(readSessionLabel(state(), 'vm1:crew/wrk9')).toBe('crew/wrk9');
	});

	it('named → the name, and aloud without the machine in front', () => {
		expect(readSessionLabel(named(), REMOTE)).toBe('voice os dev');
		expect(readLabel(state(), REMOTE)).toBe('Personal crew/main');
		expect(readLabel(named(), REMOTE)).toBe('voice os dev');
	});

	it("the name cleared → crew's label and the machine in front again", () => {
		const cleared = run([{ type: 'rename_session', ref: REMOTE, name: '' }], { start: named() });

		expect(readLabel(cleared.state, REMOTE)).toBe('Personal crew/main');
	});

	it('a named active session → announced by its name, no machine in front', () => {
		const active = run([{ type: 'activate', ref: REMOTE }], { start: named() }).state;

		expect(describeAnnouncement({ label: readLabel(active, REMOTE), kind: 'done' })).toBe(
			'voice os dev is done.',
		);
	});

	it("what waits on a machine → said by the sessions' names", () => {
		const waiting = run([{ type: 'narration', ref: REMOTE, needsUser: true, text: 'Push it?' }], {
			start: named(),
		}).state;

		expect(describeMachineWaiting(waiting, 'vm1')).toBe(
			'Personal. voice os dev is waiting on you.',
		);
	});
});

describe('releaseRefs', () => {
	const base = (): State => ({
		...createInitialState(),
		switchOffer: { ref: 'a', at: 1 },
		devOffer: { ref: 'b', servers: ['api'], at: 1 },
		targetAsk: { ref: 'b', screen: 'a', text: 'hi', at: 1 },
		lastSpokenSend: { ref: 'a', id: 'x', text: 'hi', at: 1 },
		meanwhile: [
			{ ref: 'a', kind: 'done', about: null, at: 1 },
			{ ref: 'b', kind: 'done', about: null, at: 1 },
		],
		denials: [{ id: 'd', ref: 'a', toolName: 'Bash', summary: 'rm', at: 1 }],
	});

	it("a gone ref's offers, updates and denials go; the others' stay", () => {
		const released = releaseRefs(base(), (ref) => ref === 'a');

		expect(released.switchOffer).toBeNull();
		expect(released.lastSpokenSend).toBeNull();
		expect(released.denials).toEqual([]);
		expect(released.devOffer).toEqual({ ref: 'b', servers: ['api'], at: 1 });
		expect(released.meanwhile.map((item) => item.ref)).toEqual(['b']);
	});

	it('a "For X?" whose screen is gone → gone too', () => {
		expect(releaseRefs(base(), (ref) => ref === 'a').targetAsk).toBeNull();
	});

	it('nothing gone → everything kept', () => {
		const state = base();
		const released = releaseRefs(state, () => false);

		expect(released).toEqual(state);
	});
});
