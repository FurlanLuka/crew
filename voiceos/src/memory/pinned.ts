import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './json-file.js';
import { createLogger } from '../log.js';
import type { Store } from '../state/store.js';

const log = createLogger('pinned');

export const loadPinned = (file: string): string[] => {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;

		return Array.isArray(parsed)
			? parsed.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
			: [];
	} catch {
		// A missing or corrupt file starts with nothing pinned, as a first start does.
		return [];
	}
};

export const savePinned = (file: string, refs: string[]): void => {
	writeJsonAtomic(file, refs);
};

const isSameList = (left: string[], right: string[]): boolean =>
	left.length === right.length && left.every((ref, index) => ref === right[index]);

interface PersistPinnedParams {
	store: Store;
	file: string;
}

// Call after the machines are loaded: pinned_loaded drops the pins of machines the state does not know.
export const persistPinned = ({ store, file }: PersistPinnedParams): void => {
	let written = loadPinned(file);
	// Before the saved list is merged, state.pinned is only what was pinned since boot: writing it
	// would lose the rest.
	let isLoaded = false;

	store.subscribe((stamped, state) => {
		if (stamped.input.type === 'pinned_loaded') {
			isLoaded = true;
		}

		if (!isLoaded || isSameList(state.pinned, written)) {
			return;
		}

		try {
			savePinned(file, state.pinned);
			written = state.pinned;
		} catch (error) {
			log.warn('pins not saved', { error: String(error) });
		}
	});

	store.dispatch({ type: 'pinned_loaded', refs: written });
};
