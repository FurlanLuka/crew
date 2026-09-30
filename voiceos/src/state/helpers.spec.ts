import { describe, expect, it } from 'bun:test';
import type { Input, State } from '../shared/protocol.js';
import { describeMachineWaiting, readSessionLabel } from '../shared/machines.js';
import { run, worktree } from '../../test/support/reduce.js';
import { readLabel, truncateText } from './helpers.js';
import { describeAnnouncement, readAnnouncedLabel } from './held-lines.js';

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

	it('a named pinned session → "Your pinned <name>", no "on <machine>"', () => {
		const pinned = run([{ type: 'pin_session', ref: REMOTE }], { start: named() }).state;

		expect(
			describeAnnouncement({
				label: readAnnouncedLabel(pinned, REMOTE, readLabel(pinned, REMOTE)),
				kind: 'done',
			}),
		).toBe('Your pinned voice os dev is done.');
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
