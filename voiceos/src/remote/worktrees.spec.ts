import { describe, expect, it } from 'bun:test';
import { worktree } from '../../test/support/reduce.js';
import { composeWorktrees } from './worktrees.js';

describe('composeWorktrees', () => {
	const setup = { ...worktree('setup'), isPinned: true };

	it('no machines → setup and this Mac, as before', () => {
		expect(composeWorktrees({ setup, local: [worktree('a/main')], remotes: {} })).toEqual([
			setup,
			worktree('a/main'),
		]);
	});

	it('the same worktree on two machines → two refs, the label as each knows it', () => {
		const composed = composeWorktrees({
			setup,
			local: [worktree('a/main')],
			remotes: { vm1: [worktree('a/main')] },
		});

		expect(composed.map((info) => [info.ref, info.label])).toEqual([
			['setup', 'setup'],
			['a/main', 'a/main'],
			['vm1:a/main', 'a/main'],
		]);
	});
});
