import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './json-file.js';
import { createLogger } from '../log.js';
import type { Store } from '../state/store.js';

const log = createLogger('setup');

export const loadOnboarded = (file: string): boolean => {
	try {
		const saved = JSON.parse(readFileSync(file, 'utf8')) as { onboarded?: unknown };

		return saved.onboarded === true;
	} catch {
		// A missing or corrupt file is not onboarded: the page marks a Mac with worktrees itself.
		return false;
	}
};

interface PersistOnboardedParams {
	store: Store;
	file: string;
}

// The first run is shown once per Mac: loaded at boot, written on every change after.
export const persistOnboarded = ({ store, file }: PersistOnboardedParams): void => {
	let written = loadOnboarded(file);

	store.dispatch({ type: 'set_onboarded', onboarded: written });
	store.subscribe((_stamped, state) => {
		if (state.onboarded === written) {
			return;
		}

		try {
			writeJsonAtomic(file, { onboarded: state.onboarded });
			written = state.onboarded;
			log.info('onboarded saved', { onboarded: state.onboarded });
		} catch (error) {
			log.warn('onboarded not saved', { error: String(error) });
		}
	});
};
