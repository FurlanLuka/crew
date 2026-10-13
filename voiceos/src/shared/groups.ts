// The top bar's session groups: pure rules shared by the reducer and the page. A group is a
// membership over the active set; where it sits in the bar is where its first member sits.
import { listActiveRefs } from './active.js';
import { isChatRef, isSetupRef, splitRef } from './machine-ref.js';
import { GROUP_COLORS, type GroupColor, type SessionGroup, type State } from './protocol.js';

export const MAX_GROUP_NAME_LENGTH = 40;

// What nextGroupId makes: the gateway and the saved file accept nothing else.
export const GROUP_ID_PATTERN = /^g\d{1,6}$/;

export type BarItem =
	| { kind: 'session'; ref: string }
	// refs: the members present now, in the bar's order.
	| { kind: 'group'; group: SessionGroup; refs: string[] };

export const findGroupOf = (groups: SessionGroup[], ref: string): SessionGroup | null =>
	groups.find((group) => group.refs.includes(ref)) ?? null;

export const findGroup = (groups: SessionGroup[], id: string): SessionGroup | null =>
	groups.find((group) => group.id === id) ?? null;

// A group's members present now (an out-of-reach machine's are not), in the bar's order.
export const listPresentMembers = (state: State, group: SessionGroup): string[] =>
	listActiveRefs(state).filter((ref) => group.refs.includes(ref));

// What the bar draws, in order: a loose tab, or a group at its first member. A group with fewer than
// two members present draws as its one tab, or not at all; it stays a group for when they are back.
export const layoutBar = (state: State): BarItem[] => {
	const items: BarItem[] = [];
	const placed = new Set<string>();

	for (const ref of listActiveRefs(state)) {
		const group = findGroupOf(state.groups, ref);

		if (!group) {
			items.push({ kind: 'session', ref });
			continue;
		}

		if (placed.has(group.id)) {
			continue;
		}

		placed.add(group.id);
		const refs = listPresentMembers(state, group);

		items.push(refs.length >= 2 ? { kind: 'group', group, refs } : { kind: 'session', ref });
	}

	return items;
};

// normalizeGroups keeps an unchanged group's object, so identity says whether anything changed.
const isSameGroups = (left: SessionGroup[], right: SessionGroup[]): boolean =>
	left.length === right.length && left.every((group, index) => group === right[index]);

// The open group as the bar draws it, with its members present now: none when it is not open, or
// has fewer than two present (the bar draws it as a plain tab then, and Esc goes up as usual).
export const readOpenGroup = (state: State): Extract<BarItem, { kind: 'group' }> | null =>
	layoutBar(state).find(
		(item): item is Extract<BarItem, { kind: 'group' }> =>
			item.kind === 'group' && item.group.id === state.openGroup,
	) ?? null;

const isSameList = (left: string[], right: string[]): boolean =>
	left.length === right.length && left.every((ref, index) => ref === right[index]);

// Groups as the active set allows them: members still active, each in one group (the first that
// holds it), in the active order; a group left with one member is gone. An active member whose
// machine is out of reach stays. The same array back when nothing changed.
export const normalizeGroups = (groups: SessionGroup[], active: string[]): SessionGroup[] => {
	const held = new Set<string>();
	const normalized: SessionGroup[] = [];

	for (const group of groups) {
		const refs = active.filter(
			(ref) => !isSetupRef(ref) && group.refs.includes(ref) && !held.has(ref),
		);

		if (refs.length < 2) {
			continue;
		}

		for (const ref of refs) {
			held.add(ref);
		}

		normalized.push(isSameList(refs, group.refs) ? group : { ...group, refs });
	}

	return isSameGroups(normalized, groups) ? groups : normalized;
};

// Each group's members brought together at its first member, so a group is one block in the active
// order and the bar's order is the active order. The same array back when nothing moved.
export const compactBlocks = (active: string[], groups: SessionGroup[]): string[] => {
	const compacted: string[] = [];
	const placed = new Set<string>();

	for (const ref of active) {
		if (placed.has(ref)) {
			continue;
		}

		const group = findGroupOf(groups, ref);
		const block = group ? active.filter((member) => group.refs.includes(member)) : [ref];

		for (const member of block) {
			placed.add(member);
		}

		compacted.push(...block);
	}

	return isSameList(compacted, active) ? active : compacted;
};

// refs, in their order, just before another ref, or at the end with null (or a ref no longer there).
// A before inside refs moves nothing.
export const moveBlock = (active: string[], refs: string[], before: string | null): string[] => {
	if (before !== null && refs.includes(before)) {
		return active;
	}

	const block = active.filter((ref) => refs.includes(ref));
	const rest = active.filter((ref) => !refs.includes(ref));
	const at = before === null || !rest.includes(before) ? rest.length : rest.indexOf(before);
	const moved = [...rest.slice(0, at), ...block, ...rest.slice(at)];

	return isSameList(moved, active) ? active : moved;
};

// The lowest g<n> no group holds: the store's seq starts again at every boot, so it cannot name one.
export const nextGroupId = (groups: SessionGroup[]): string => {
	const ids = new Set(groups.map((group) => group.id));
	let n = 1;

	while (ids.has(`g${n}`)) {
		n += 1;
	}

	return `g${n}`;
};

export const nextGroupColor = (groups: SessionGroup[]): GroupColor =>
	GROUP_COLORS.find((color) => !groups.some((group) => group.color === color)) ??
	GROUP_COLORS[groups.length % GROUP_COLORS.length] ??
	'blue';

// The workspace the sessions share ("store-front" for store-front/main and vm1:store-front/wrk1), or
// '' when they share none; a plain session's "chat" is no name.
export const suggestGroupName = (refs: string[]): string => {
	if (refs.some((ref) => isChatRef(ref) || isSetupRef(ref))) {
		return '';
	}

	const workspaces = new Set(refs.map((ref) => splitRef(ref).workspace));
	const [only] = [...workspaces];

	return workspaces.size === 1 && only ? only : '';
};

// A group's name as kept: spacing folded, cut to the limit; '' is no name.
export const toGroupName = (raw: string): string =>
	raw.trim().replace(/\s+/g, ' ').slice(0, MAX_GROUP_NAME_LENGTH).trim();
