import { describe, expect, it } from 'bun:test';
import { createInitialState, createSession } from '../state/reducer.js';
import { worktree } from '../../test/support/reduce.js';
import {
	compactBlocks,
	layoutBar,
	moveBlock,
	nextGroupColor,
	nextGroupId,
	normalizeGroups,
	readOpenGroup,
	suggestGroupName,
	toGroupName,
} from './groups.js';
import { GROUP_COLORS, type SessionGroup, type State } from './protocol.js';

const group = (id: string, refs: string[], name = id): SessionGroup => ({
	id,
	name,
	color: 'blue',
	refs,
});

const withActive = (active: string[], groups: SessionGroup[], present = active): State => ({
	...createInitialState(),
	sessions: Object.fromEntries(present.map((ref) => [ref, createSession(worktree(ref))])),
	active,
	groups,
});

describe('layoutBar', () => {
	it('a group sits at its first member, its members in the active order; loose tabs keep their places', () => {
		const items = layoutBar(
			withActive(['a/main', 'b/main', 'c/main', 'd/main'], [group('g1', ['b/main', 'd/main'])]),
		);

		expect(items).toEqual([
			{ kind: 'session', ref: 'a/main' },
			{ kind: 'group', group: group('g1', ['b/main', 'd/main']), refs: ['b/main', 'd/main'] },
			{ kind: 'session', ref: 'c/main' },
		]);
	});

	it('setup sessions never in it', () =>
		expect(layoutBar(withActive(['setup', 'a/main'], []))).toEqual([
			{ kind: 'session', ref: 'a/main' },
		]));

	it('a member not present (its machine out of reach) → not drawn; one present → a plain tab; none → nothing', () => {
		const groups = [
			group('g1', ['a/main', 'vm1:b/main']),
			group('g2', ['vm1:c/main', 'vm1:d/main']),
		];
		const state = withActive(['a/main', 'vm1:b/main', 'vm1:c/main', 'vm1:d/main'], groups, [
			'a/main',
		]);

		expect(layoutBar(state)).toEqual([{ kind: 'session', ref: 'a/main' }]);
	});
});

describe('readOpenGroup', () => {
	const lab = group('g1', ['a/main', 'vm1:b/main']);
	const groups = [lab];

	it('open and drawn as a group → it, with its present members', () => {
		const state = { ...withActive(['a/main', 'vm1:b/main'], groups), openGroup: 'g1' };

		expect(readOpenGroup(state)).toEqual({
			kind: 'group',
			group: lab,
			refs: ['a/main', 'vm1:b/main'],
		});
	});

	it('open but drawn as a plain tab (a member away), or none open → none', () => {
		const away = { ...withActive(['a/main', 'vm1:b/main'], groups, ['a/main']), openGroup: 'g1' };

		expect(readOpenGroup(away)).toBeNull();
		expect(readOpenGroup(withActive(['a/main', 'vm1:b/main'], groups))).toBeNull();
	});
});

describe('normalizeGroups', () => {
	it('members no longer active are dropped; a group left with one dissolves, and an empty one', () => {
		const groups = [group('g1', ['a/main', 'b/main', 'c/main']), group('g2', ['d/main', 'e/main'])];

		expect(normalizeGroups(groups, ['a/main', 'c/main', 'd/main'])).toEqual([
			group('g1', ['a/main', 'c/main']),
		]);
		expect(normalizeGroups(groups, [])).toEqual([]);
	});

	it('a ref in two groups stays in the first; members follow the active order', () =>
		expect(
			normalizeGroups(
				[group('g1', ['b/main', 'a/main']), group('g2', ['a/main', 'c/main', 'd/main'])],
				['a/main', 'b/main', 'c/main', 'd/main'],
			),
		).toEqual([group('g1', ['a/main', 'b/main']), group('g2', ['c/main', 'd/main'])]));

	it('a setup ref is never a member', () =>
		expect(normalizeGroups([group('g1', ['setup', 'a/main'])], ['setup', 'a/main'])).toEqual([]));

	it('nothing to change → the same array', () => {
		const groups = [group('g1', ['a/main', 'b/main'])];

		expect(normalizeGroups(groups, ['a/main', 'b/main', 'c/main'])).toBe(groups);
	});
});

describe('compactBlocks', () => {
	it("a group's members come together at its first member; loose refs keep their order", () =>
		expect(
			compactBlocks(['a/main', 'x/main', 'b/main', 'y/main'], [group('g1', ['a/main', 'b/main'])]),
		).toEqual(['a/main', 'b/main', 'x/main', 'y/main']));

	it('already together → the same array', () => {
		const active = ['x/main', 'a/main', 'b/main'];

		expect(compactBlocks(active, [group('g1', ['a/main', 'b/main'])])).toBe(active);
	});
});

describe('moveBlock', () => {
	const active = ['a/main', 'b/main', 'c/main', 'd/main'];

	it('the refs, in their order, just before another; null → the end', () => {
		expect(moveBlock(active, ['c/main', 'd/main'], 'a/main')).toEqual([
			'c/main',
			'd/main',
			'a/main',
			'b/main',
		]);
		expect(moveBlock(active, ['a/main', 'b/main'], null)).toEqual([
			'c/main',
			'd/main',
			'a/main',
			'b/main',
		]);
	});

	it('before one of its own refs, or where it already is → the same array', () => {
		expect(moveBlock(active, ['b/main', 'c/main'], 'c/main')).toBe(active);
		expect(moveBlock(active, ['b/main'], 'c/main')).toBe(active);
	});

	it('before a ref no longer there → the end', () =>
		expect(moveBlock(active, ['a/main'], 'gone/main')).toEqual([
			'b/main',
			'c/main',
			'd/main',
			'a/main',
		]));
});

describe('nextGroupId', () => {
	it('the lowest g<n> no group holds, also after groups were loaded from the file', () => {
		expect(nextGroupId([])).toBe('g1');
		expect(nextGroupId([group('g1', []), group('g3', [])])).toBe('g2');
		expect(nextGroupId([group('g1', []), group('g2', [])])).toBe('g3');
	});
});

describe('nextGroupColor', () => {
	it('the first colour no group has; all six in use → round again', () => {
		expect(nextGroupColor([])).toBe('blue');
		expect(nextGroupColor([{ ...group('g1', []), color: 'blue' }])).toBe('violet');

		const all = GROUP_COLORS.map((color, index) => ({ ...group(`g${index}`, []), color }));

		expect(nextGroupColor(all)).toBe('blue');
	});
});

describe('suggestGroupName', () => {
	it('one workspace, across worktrees and machines → its name; mixed → nothing', () => {
		expect(suggestGroupName(['store-front/main', 'vm1:store-front/wrk1'])).toBe('store-front');
		expect(suggestGroupName(['store-front/main', 'checkout-api/main'])).toBe('');
	});

	it('a plain session or a setup session → nothing ("chat" is no name)', () => {
		expect(suggestGroupName(['chat/abc', 'chat/def'])).toBe('');
		expect(suggestGroupName(['setup', 'vm1:setup'])).toBe('');
	});
});

describe('toGroupName', () => {
	it('trimmed, spacing folded, cut at 40 with no trailing space; blank → no name', () => {
		expect(toGroupName('  store   front ')).toBe('store front');
		expect(toGroupName(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
		expect(toGroupName('   ')).toBe('');
	});
});
