// The top bar's groups: the page's own arrangement of the active set. Nothing starts, stops or is
// said; groups.json follows (memory/groups.ts).
import { isActive } from '../shared/active.js';
import {
	compactBlocks,
	findGroup,
	findGroupOf,
	moveBlock,
	nextGroupId,
	normalizeGroups,
	toGroupName,
} from '../shared/groups.js';
import type { Input, SessionGroup, State } from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { withoutEffects } from './helpers.js';

const GROUP_INPUTS = [
	'create_group',
	'join_group',
	'leave_group',
	'update_group',
	'ungroup',
	'open_group',
	'move_group',
	'groups_loaded',
] as const;

type GroupInput = Extract<Input, { type: (typeof GROUP_INPUTS)[number] }>;

const GROUP_INPUT_SET = new Set<string>(GROUP_INPUTS);

export const isGroupInput = (input: Input): input is GroupInput => GROUP_INPUT_SET.has(input.type);

const withoutMember = (groups: SessionGroup[], ref: string): SessionGroup[] =>
	groups.map((group) =>
		group.refs.includes(ref)
			? { ...group, refs: group.refs.filter((kept) => kept !== ref) }
			: group,
	);

const replaceGroup = (groups: SessionGroup[], next: SessionGroup): SessionGroup[] =>
	groups.map((group) => (group.id === next.id ? next : group));

// The ref just after a group's block in the active order: where a member joining it lands.
const readAfterBlock = (state: State, group: SessionGroup): string | null => {
	const last = state.active.findLastIndex((ref) => group.refs.includes(ref));

	return state.active[last + 1] ?? null;
};

interface MergedGroups {
	groups: SessionGroup[];
	// A saved id a group made since boot already used, and the id it has now.
	renamed: Map<string, string>;
}

// Saved groups merged with those made since boot: those win, a saved ref they already hold is
// dropped, a saved id they use is renumbered. The reconcile drops refs no longer active.
const mergeLoaded = (state: State, loaded: SessionGroup[]): MergedGroups =>
	loaded.reduce<MergedGroups>(
		({ groups, renamed }, saved) => {
			const refs = saved.refs.filter((ref) => !findGroupOf(groups, ref));
			const id = findGroup(groups, saved.id) ? nextGroupId([...groups, ...loaded]) : saved.id;

			return {
				groups: [...groups, { ...saved, id, refs }],
				renamed: id === saved.id ? renamed : new Map([...renamed, [saved.id, id]]),
			};
		},
		{ groups: state.groups, renamed: new Map() },
	);

const createGroup = (state: State, input: Extract<GroupInput, { type: 'create_group' }>): State => {
	const [target, dragged] = input.refs;
	const name = toGroupName(input.name);

	if (
		target === dragged ||
		!isActive(state, target) ||
		!isActive(state, dragged) ||
		findGroupOf(state.groups, target) ||
		!name
	) {
		return state;
	}

	const groups = withoutMember(state.groups, dragged);
	const at = state.active.indexOf(target);
	const group: SessionGroup = {
		id: nextGroupId(groups),
		name,
		color: input.color,
		refs: [target, dragged],
	};

	return {
		...state,
		groups: [...groups, group],
		active: moveBlock(state.active, [dragged], state.active[at + 1] ?? null),
	};
};

const joinGroup = (state: State, id: string, ref: string): State => {
	const group = findGroup(state.groups, id);

	if (!group || group.refs.includes(ref) || !isActive(state, ref)) {
		return state;
	}

	const joined = { ...group, refs: [...group.refs, ref] };

	return {
		...state,
		groups: replaceGroup(withoutMember(state.groups, ref), joined),
		active: moveBlock(state.active, [ref], readAfterBlock(state, group)),
	};
};

const moveGroup = (state: State, id: string, before: string | null): State => {
	const group = findGroup(state.groups, id);

	if (!group) {
		return state;
	}

	// Never into the middle of another group: before its block instead.
	const anchor = before === null ? null : (findGroupOf(state.groups, before)?.refs[0] ?? before);

	return { ...state, active: moveBlock(state.active, group.refs, anchor) };
};

const updateGroup = (state: State, input: Extract<GroupInput, { type: 'update_group' }>): State => {
	const group = findGroup(state.groups, input.id);

	if (!group) {
		return state;
	}

	// An empty name keeps the old one: a group is always called something.
	const name = input.name === undefined ? '' : toGroupName(input.name);

	return {
		...state,
		groups: replaceGroup(state.groups, {
			...group,
			name: name || group.name,
			color: input.color ?? group.color,
		}),
	};
};

export const reduceGroup = (state: State, input: GroupInput): ReducerResult => {
	switch (input.type) {
		case 'create_group':
			return withoutEffects(createGroup(state, input));

		case 'join_group':
			return withoutEffects(joinGroup(state, input.id, input.ref));

		case 'leave_group': {
			const group = findGroupOf(state.groups, input.ref);

			// It lands just after the group, beside where it was.
			return withoutEffects(
				group
					? {
							...state,
							groups: withoutMember(state.groups, input.ref),
							active: moveBlock(state.active, [input.ref], readAfterBlock(state, group)),
						}
					: state,
			);
		}

		case 'update_group':
			return withoutEffects(updateGroup(state, input));

		case 'ungroup':
			return withoutEffects({
				...state,
				groups: state.groups.filter((group) => group.id !== input.id),
			});

		case 'open_group':
			return withoutEffects(
				input.id === null || findGroup(state.groups, input.id)
					? { ...state, openGroup: input.id }
					: state,
			);

		case 'move_group':
			return withoutEffects(moveGroup(state, input.id, input.before));

		case 'groups_loaded': {
			const { groups, renamed } = mergeLoaded(state, input.groups);
			const savedOpen =
				input.openGroup === null ? null : (renamed.get(input.openGroup) ?? input.openGroup);
			const loadedOpen = savedOpen && findGroup(groups, savedOpen) ? savedOpen : null;

			return withoutEffects({ ...state, groups, openGroup: state.openGroup ?? loadedOpen });
		}
	}
};

const isOpenGroupHidingScreen = (before: State, after: State, open: SessionGroup): boolean =>
	after.view !== before.view &&
	after.view.kind === 'session' &&
	!open.refs.includes(after.view.ref);

// A session activated while a group is open would get a tab nobody sees.
const hasNewActive = (before: State, after: State, open: SessionGroup): boolean =>
	after.active.some((ref) => !before.active.includes(ref) && !open.refs.includes(ref));

// Runs after every input: groups follow the active set (a deactivated session leaves its group, one
// left alone dissolves), each group stays one block in the active order, and the open group closes
// when it is gone or would hide what just came on screen or was activated.
export const reconcileGroups = (before: State, after: State): State => {
	if (
		after.active === before.active &&
		after.view === before.view &&
		after.groups === before.groups &&
		after.openGroup === before.openGroup
	) {
		return after;
	}

	const groups = normalizeGroups(after.groups, after.active);
	const active = compactBlocks(after.active, groups);
	const open = after.openGroup === null ? null : findGroup(groups, after.openGroup);
	const openGroup =
		open && !isOpenGroupHidingScreen(before, after, open) && !hasNewActive(before, after, open)
			? open.id
			: null;

	if (groups === after.groups && active === after.active && openGroup === after.openGroup) {
		return after;
	}

	return { ...after, groups, active, openGroup };
};
