import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './json-file.js';
import { createLogger } from '../log.js';
import { DEFAULT_LANGUAGES, toLanguages } from '../shared/languages.js';
import type { Store } from '../state/store.js';

const log = createLogger('languages');

export const loadLanguages = (file: string): string[] => {
	try {
		return toLanguages(JSON.parse(readFileSync(file, 'utf8')));
	} catch {
		// A missing or corrupt file is English, as before the setting.
		return DEFAULT_LANGUAGES;
	}
};

interface PersistLanguagesParams {
	store: Store;
	file: string;
}

// The languages survive a restart: loaded once, written on every change after.
export const persistLanguages = ({ store, file }: PersistLanguagesParams): void => {
	let written = loadLanguages(file);

	store.dispatch({ type: 'set_languages', languages: written });
	store.subscribe((_stamped, state) => {
		if (JSON.stringify(state.languages) === JSON.stringify(written)) {
			return;
		}

		try {
			writeJsonAtomic(file, state.languages);
			written = state.languages;
			log.info('speech languages', { languages: state.languages });
		} catch (error) {
			log.warn('languages not saved', { error: String(error) });
		}
	});
};
