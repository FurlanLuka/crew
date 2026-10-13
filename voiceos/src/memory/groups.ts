import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './json-file.js';
import { createLogger } from '../log.js';
import { GROUP_ID_PATTERN, toGroupName } from '../shared/groups.js';
import { GROUP_COLORS, type GroupColor, type SessionGroup } from '../shared/protocol.js';
import type { Store } from '../state/store.js';

const log = createLogger('groups');

export interface SavedGroups {
	groups: SessionGroup[];
	openGroup: string | null;
}

const NO_GROUPS: SavedGroups = { groups: [], openGroup: null };

const isGroupColor = (value: unknown): value is GroupColor =>
	GROUP_COLORS.some((color) => color === value);

const readGroup = (value: unknown): SessionGroup | null => {
	if (!value || typeof value !== 'object') {
		return null;
	}

	const { id, name, color, refs } = value as Record<string, unknown>;

	// Held to the page's own rules: an id the gateway would refuse could never be changed again.
	const kept = typeof name === 'string' ? toGroupName(name) : '';

	if (
		typeof id !== 'string' ||
		!GROUP_ID_PATTERN.test(id) ||
		!kept ||
		!isGroupColor(color) ||
		!Array.isArray(refs)
	) {
		return null;
	}

	return {
		id,
		name: kept,
		color,
		refs: refs.filter((ref): ref is string => typeof ref === 'string'),
	};
};

export const loadGroups = (file: string): SavedGroups => {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return NO_GROUPS;
		}

		const { groups, openGroup } = parsed as Record<string, unknown>;
		const read = (Array.isArray(groups) ? groups : [])
			.map(readGroup)
			.filter((group): group is SessionGroup => group !== null)
			// A duplicated id keeps its first group.
			.filter((group, index, all) => all.findIndex((other) => other.id === group.id) === index);

		return { groups: read, openGroup: typeof openGroup === 'string' ? openGroup : null };
	} catch {
		// A missing or corrupt file starts with no groups: every active session is its own tab.
		return NO_GROUPS;
	}
};

export const saveGroups = (file: string, saved: SavedGroups): void => {
	writeJsonAtomic(file, saved);
};

interface PersistGroupsParams {
	store: Store;
	file: string;
}

// Call after the active set is loaded: groups_loaded keeps only members still active.
export const persistGroups = ({ store, file }: PersistGroupsParams): void => {
	const loaded = loadGroups(file);
	let written = JSON.stringify(loaded);
	// Before the saved groups are merged, state.groups is only what was grouped since boot: writing it
	// would lose the rest.
	let isLoaded = false;

	store.subscribe((stamped, state) => {
		if (stamped.input.type === 'groups_loaded') {
			isLoaded = true;
		}

		const next: SavedGroups = { groups: state.groups, openGroup: state.openGroup };
		const json = JSON.stringify(next);

		if (!isLoaded || json === written) {
			return;
		}

		try {
			saveGroups(file, next);
			written = json;
			log.info('groups saved', {
				input: stamped.input.type,
				groups: state.groups.map((group) => ({ id: group.id, members: group.refs.length })),
				openGroup: state.openGroup,
			});
		} catch (error) {
			log.warn('groups not saved', { error: String(error) });
		}
	});

	log.info('groups loaded', { count: loaded.groups.length, openGroup: loaded.openGroup });
	store.dispatch({ type: 'groups_loaded', ...loaded });
};
