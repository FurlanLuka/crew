import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './json-file.js';
import { createLogger } from '../log.js';
import type { Store } from '../state/store.js';

const log = createLogger('voice');

// The voice switches kept across restarts, each one boolean in its own file: voice off (nothing
// listens or speaks) and speech off (it listens, it never speaks).
type VoiceSwitch = 'voiceOff' | 'speechOff';

// Read before anything voice starts: Discord's bot must not join a channel only to leave it.
const loadSwitch = (file: string, key: VoiceSwitch): boolean => {
	try {
		const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

		return saved[key] === true;
	} catch {
		// A missing or corrupt file is the switch's default, as before the setting.
		return false;
	}
};

export const loadVoiceOff = (file: string): boolean => loadSwitch(file, 'voiceOff');

export const loadSpeechOff = (file: string): boolean => loadSwitch(file, 'speechOff');

interface PersistSwitchParams {
	store: Store;
	file: string;
}

// Loaded once into the state, written on every change after.
const persistSwitch = (
	{ store, file }: PersistSwitchParams,
	key: VoiceSwitch,
	label: string,
	toInput: (isOn: boolean) => Parameters<Store['dispatch']>[0],
): void => {
	let written = loadSwitch(file, key);

	store.dispatch(toInput(written));
	store.subscribe((_stamped, state) => {
		if (state[key] === written) {
			return;
		}

		try {
			writeJsonAtomic(file, { [key]: state[key] });
			written = state[key];
		} catch (error) {
			log.warn(`${label} not saved`, { error: String(error) });
		}
	});
};

export const persistVoiceOff = (params: PersistSwitchParams): void =>
	persistSwitch(params, 'voiceOff', 'voice off', (voiceOff) => ({
		type: 'set_voice_off',
		voiceOff,
	}));

export const persistSpeechOff = (params: PersistSwitchParams): void =>
	persistSwitch(params, 'speechOff', 'speech off', (speechOff) => ({
		type: 'set_speech_off',
		speechOff,
	}));
