import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './json-file.js';
import { createLogger } from '../log.js';
import { findNamedRef } from '../state/names.js';
import type { Store } from '../state/store.js';

const log = createLogger('names');

export const loadNames = (file: string): Record<string, string> => {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}

		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] =>
					typeof entry[1] === 'string' && entry[1].trim() !== '',
			),
		);
	} catch {
		// A missing or corrupt file starts with no names: every session shows its crew label.
		return {};
	}
};

export const saveNames = (file: string, names: Record<string, string>): void => {
	writeJsonAtomic(file, names);
};

interface PersistNamesParams {
	store: Store;
	file: string;
}

// Call after the machines are loaded: names_loaded drops the names of machines the state does not know.
export const persistNames = ({ store, file }: PersistNamesParams): void => {
	let written = loadNames(file);
	// Before the saved names are merged, state.names is only what was named since boot: writing it
	// would lose the rest.
	let isLoaded = false;

	store.subscribe((stamped, state) => {
		const { input } = stamped;

		if (input.type === 'names_loaded') {
			isLoaded = true;
		}

		// The reducer stays pure: a refusal is only visible as a name that did not change.
		if (input.type === 'rename_session' && input.name.trim()) {
			const owner = findNamedRef(state, input.name);

			if (owner !== input.ref) {
				log.info('rename refused', {
					ref: input.ref,
					takenBy: owner,
					known: Boolean(state.sessions[input.ref]),
				});
			}
		}

		if (!isLoaded || JSON.stringify(state.names) === JSON.stringify(written)) {
			return;
		}

		try {
			saveNames(file, state.names);
			written = state.names;
		} catch (error) {
			log.warn('names not saved', { error: String(error) });
		}
	});

	store.dispatch({ type: 'names_loaded', names: written });
};
