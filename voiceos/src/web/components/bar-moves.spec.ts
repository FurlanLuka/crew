import { describe, expect, it } from 'bun:test';
import type { BarItem } from '../../shared/groups.js';
import { canJoin, readDrop, readDropTarget, readDropZone, readKeyMove } from './bar-moves.js';

const tab = (ref: string): BarItem => ({ kind: 'session', ref });

// a, then the group g1 (b, c), then d.
const items: BarItem[] = [
	tab('a/main'),
	{
		kind: 'group',
		group: { id: 'g1', name: 'store', color: 'blue', refs: ['b/main', 'c/main'] },
		refs: ['b/main', 'c/main'],
	},
	tab('d/main'),
];

describe('readDropZone', () => {
	it('the outer quarters → beside; the middle half → into, when it can join', () => {
		expect(readDropZone(10, 100, true)).toBe('before');
		expect(readDropZone(25, 100, true)).toBe('into');
		expect(readDropZone(75, 100, true)).toBe('into');
		expect(readDropZone(76, 100, true)).toBe('after');
	});

	it('it cannot join (an open group, a group carried, its own group) → beside, by the nearer half', () => {
		expect(readDropZone(40, 100, false)).toBe('before');
		expect(readDropZone(60, 100, false)).toBe('after');
	});
});

describe('readDropTarget', () => {
	it('before a tab → before it; after it → before the next, never before the one carried; last → the end', () => {
		const tabs = [tab('a/main'), tab('b/main'), tab('c/main')];

		expect(readDropTarget(tabs, 'c/main', 'a/main', 'before')).toBe('a/main');
		expect(readDropTarget(tabs, 'a/main', 'b/main', 'after')).toBe('c/main');
		expect(readDropTarget(tabs, 'b/main', 'a/main', 'after')).toBe('c/main');
		expect(readDropTarget(tabs, 'a/main', 'c/main', 'after')).toBeNull();
	});

	it('a group is one place, starting at its first member', () => {
		expect(readDropTarget(items, 'd/main', 'g1', 'before')).toBe('b/main');
		expect(readDropTarget(items, 'd/main', 'a/main', 'after')).toBe('b/main');
		expect(readDropTarget(items, 'a/main', 'g1', 'after')).toBe('d/main');
		expect(readDropTarget(items, 'g1', 'a/main', 'before')).toBe('a/main');
	});
});

describe('readKeyMove', () => {
	it('Alt+← and Alt+→ → one place along, a closed group counting as one; at an end, no move', () => {
		expect(readKeyMove(items, 'd/main', -1)).toEqual({ before: 'b/main' });
		expect(readKeyMove(items, 'a/main', 1)).toEqual({ before: 'd/main' });
		expect(readKeyMove(items, 'g1', -1)).toEqual({ before: 'a/main' });
		expect(readKeyMove(items, 'g1', 1)).toEqual({ before: null });
		expect(readKeyMove(items, 'a/main', -1)).toBeNull();
		expect(readKeyMove(items, 'd/main', 1)).toBeNull();
	});
});

describe('canJoin', () => {
	const groups = [
		{ id: 'g1', name: 'store', color: 'blue' as const, refs: ['b/main', 'c/main'] },
		// e's partner is on a machine out of reach: e is drawn alone, still grouped.
		{ id: 'g2', name: 'lab', color: 'pink' as const, refs: ['e/main', 'vm1:f/main'] },
	];
	const chip = items[1] as BarItem;

	it('a loose tab onto a loose tab or onto a group → yes', () => {
		expect(
			canJoin({ dragged: tab('a/main'), target: tab('d/main'), groups, isOpenBox: false }),
		).toBe(true);
		expect(canJoin({ dragged: tab('a/main'), target: chip, groups, isOpenBox: false })).toBe(true);
	});

	it('inside an open group, a carried group, onto its own group, onto itself, onto a grouped tab drawn alone → no', () => {
		expect(
			canJoin({ dragged: tab('b/main'), target: tab('c/main'), groups, isOpenBox: true }),
		).toBe(false);
		expect(canJoin({ dragged: chip, target: tab('a/main'), groups, isOpenBox: false })).toBe(false);
		expect(canJoin({ dragged: tab('b/main'), target: chip, groups, isOpenBox: false })).toBe(false);
		expect(
			canJoin({ dragged: tab('a/main'), target: tab('a/main'), groups, isOpenBox: false }),
		).toBe(false);
		expect(
			canJoin({ dragged: tab('a/main'), target: tab('e/main'), groups, isOpenBox: false }),
		).toBe(false);
	});
});

describe('readDrop', () => {
	const chip = items[1] as BarItem;

	it('into a group → join it; into a loose tab → name a new group', () => {
		expect(readDrop({ items, dragged: tab('d/main'), target: chip, zone: 'into' })).toEqual({
			kind: 'join',
			id: 'g1',
			ref: 'd/main',
		});
		expect(
			readDrop({ items, dragged: tab('d/main'), target: tab('a/main'), zone: 'into' }),
		).toEqual({
			kind: 'name',
			target: 'a/main',
			dragged: 'd/main',
		});
	});

	it('beside → a tab moves in the active set, a group as a whole', () => {
		expect(readDrop({ items, dragged: tab('d/main'), target: chip, zone: 'before' })).toEqual({
			kind: 'move_active',
			ref: 'd/main',
			before: 'b/main',
		});
		expect(readDrop({ items, dragged: chip, target: tab('d/main'), zone: 'after' })).toEqual({
			kind: 'move_group',
			id: 'g1',
			before: null,
		});
	});

	it('a group carried can never go into anything: it lands before', () =>
		expect(readDrop({ items, dragged: chip, target: tab('a/main'), zone: 'into' })).toEqual({
			kind: 'move_group',
			id: 'g1',
			before: 'a/main',
		}));
});
