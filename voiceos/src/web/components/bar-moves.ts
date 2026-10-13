// Where a tab or a group lands in the top bar, by drag or Alt+arrow: pure, over what the bar draws.
import { findGroupOf, type BarItem } from '../../shared/groups.js';
import type { SessionGroup } from '../../shared/protocol.js';

export type DropZone = 'before' | 'after' | 'into';

// A session tab or a group chip: what is dragged, and what it is dropped on.
export const readItemKey = (item: BarItem): string =>
	item.kind === 'session' ? item.ref : item.group.id;

// The active ref a move lands in front of: a group is one block in the active order and starts at its
// first member, present or not.
const readAnchor = (item: BarItem): string =>
	item.kind === 'session' ? item.ref : (item.group.refs[0] ?? '');

// The middle half of a tab groups with it (when it can); the outer quarters, and the middle when it
// cannot, put the dragged one beside it.
export const readDropZone = (offset: number, width: number, canJoin: boolean): DropZone => {
	const at = width > 0 ? offset / width : 0;

	if (at < 0.25) {
		return 'before';
	}

	if (at > 0.75) {
		return 'after';
	}

	if (canJoin) {
		return 'into';
	}

	return at < 0.5 ? 'before' : 'after';
};

// Where a dragged item lands: just before the item it is over, or before the one after it. The
// dragged item itself is never the anchor; null is the end.
export const readDropTarget = (
	items: BarItem[],
	dragged: string,
	over: string,
	side: 'before' | 'after',
): string | null => {
	const at = items.findIndex((item) => readItemKey(item) === over);
	const target = items[at];

	if (!target) {
		return null;
	}

	if (side === 'before') {
		return readAnchor(target);
	}

	const next = items.slice(at + 1).find((item) => readItemKey(item) !== dragged);

	return next ? readAnchor(next) : null;
};

// Alt+← / Alt+→: one item along, a closed group counting as one; null when it is already at that end.
export const readKeyMove = (
	items: BarItem[],
	key: string,
	step: -1 | 1,
): { before: string | null } | null => {
	const at = items.findIndex((item) => readItemKey(item) === key);

	if (at < 0 || (step < 0 && at === 0) || (step > 0 && at === items.length - 1)) {
		return null;
	}

	const landing = step < 0 ? items[at - 1] : items[at + 2];

	return { before: landing ? readAnchor(landing) : null };
};

interface CanJoinParams {
	dragged: BarItem;
	target: BarItem;
	groups: SessionGroup[];
	// Inside an open group the tabs only move among themselves.
	isOpenBox: boolean;
}

// Whether the middle of target takes the dragged item in: a loose tab (or one from another group)
// onto a group it is not in, or onto a loose tab. Never a carried group, never inside an open group,
// never onto a grouped tab drawn alone (its partner's machine away).
export const canJoin = ({ dragged, target, groups, isOpenBox }: CanJoinParams): boolean => {
	if (isOpenBox || dragged.kind !== 'session' || readItemKey(target) === readItemKey(dragged)) {
		return false;
	}

	return target.kind === 'group'
		? !target.group.refs.includes(dragged.ref)
		: !findGroupOf(groups, target.ref);
};

export type DropAction =
	| { kind: 'join'; id: string; ref: string }
	// A tab on a loose tab: the group is named before it is made.
	| { kind: 'name'; target: string; dragged: string }
	| { kind: 'move_group'; id: string; before: string | null }
	| { kind: 'move_active'; ref: string; before: string | null };

interface ReadDropParams {
	items: BarItem[];
	dragged: BarItem;
	target: BarItem;
	zone: DropZone;
}

// What a drop does, once readDropZone has said where (and whether the middle takes it in).
export const readDrop = ({ items, dragged, target, zone }: ReadDropParams): DropAction => {
	if (zone === 'into' && dragged.kind === 'session') {
		return target.kind === 'group'
			? { kind: 'join', id: target.group.id, ref: dragged.ref }
			: { kind: 'name', target: target.ref, dragged: dragged.ref };
	}

	const before = readDropTarget(
		items,
		readItemKey(dragged),
		readItemKey(target),
		zone === 'after' ? 'after' : 'before',
	);

	return dragged.kind === 'group'
		? { kind: 'move_group', id: dragged.group.id, before }
		: { kind: 'move_active', ref: dragged.ref, before };
};
