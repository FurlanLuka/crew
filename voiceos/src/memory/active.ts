import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from './json-file.js';
import { createLogger } from '../log.js';
import { SETUP_REF } from '../shared/machine-ref.js';
import type { Store } from '../state/store.js';

const log = createLogger('active');

const readRefs = (file: string): string[] => {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;

		return Array.isArray(parsed)
			? parsed.filter(
					(ref): ref is string => typeof ref === 'string' && ref.length > 0 && ref !== SETUP_REF,
				)
			: [];
	} catch {
		// A corrupt file starts with nothing active, as a first start does.
		return [];
	}
};

interface LoadActiveParams {
	file: string;
	// pinned.json, from before the active set: its pins become the active set once.
	legacyFile: string;
}

// Only a missing active.json reads the old pins: an emptied set stays empty.
export const loadActive = ({ file, legacyFile }: LoadActiveParams): string[] => {
	if (existsSync(file)) {
		return readRefs(file);
	}

	if (!existsSync(legacyFile)) {
		return [];
	}

	const migrated = readRefs(legacyFile);

	try {
		writeJsonAtomic(file, migrated);
		log.info('pins became the active set', { count: migrated.length });
	} catch (error) {
		log.warn('active set not saved', { error: String(error) });
	}

	return migrated;
};

const isSameList = (left: string[], right: string[]): boolean =>
	left.length === right.length && left.every((ref, index) => ref === right[index]);

interface PersistActiveParams extends LoadActiveParams {
	store: Store;
}

// Call after the machines are loaded: active_loaded drops the refs of machines the state does not know.
export const persistActive = ({ store, file, legacyFile }: PersistActiveParams): void => {
	let written = loadActive({ file, legacyFile });
	// Before the saved list is merged, state.active is only what was activated since boot: writing it
	// would lose the rest.
	let isLoaded = false;

	store.subscribe((stamped, state) => {
		if (stamped.input.type === 'active_loaded') {
			isLoaded = true;
		}

		if (!isLoaded || isSameList(state.active, written)) {
			return;
		}

		try {
			writeJsonAtomic(file, state.active);
			written = state.active;
		} catch (error) {
			log.warn('active set not saved', { error: String(error) });
		}
	});

	store.dispatch({ type: 'active_loaded', refs: written });
};
