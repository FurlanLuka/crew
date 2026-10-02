import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './json-file.js';
import { createLogger } from '../log.js';
import type { Store } from '../state/store.js';

const log = createLogger('voice');

// Read before anything voice starts: Discord's bot must not join a channel only to leave it.
export const loadVoiceOff = (file: string): boolean => {
	try {
		const saved = JSON.parse(readFileSync(file, 'utf8')) as { voiceOff?: unknown };

		return saved.voiceOff === true;
	} catch {
		// A missing or corrupt file is voice on, as before the setting.
		return false;
	}
};

interface PersistVoiceOffParams {
	store: Store;
	file: string;
}

// Voice off survives a restart: loaded once, written on every change after.
export const persistVoiceOff = ({ store, file }: PersistVoiceOffParams): void => {
	let written = loadVoiceOff(file);

	store.dispatch({ type: 'set_voice_off', voiceOff: written });
	store.subscribe((_stamped, state) => {
		if (state.voiceOff === written) {
			return;
		}

		try {
			writeJsonAtomic(file, { voiceOff: state.voiceOff });
			written = state.voiceOff;
		} catch (error) {
			log.warn('voice off not saved', { error: String(error) });
		}
	});
};
