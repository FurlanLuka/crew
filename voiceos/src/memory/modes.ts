import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './json-file.js';
import { createLogger } from '../log.js';
import type { SessionModeEntry } from '../shared/protocol.js';
import { readMode } from '../shared/modes.js';
import type { Store } from '../state/store.js';

const log = createLogger('modes');

export const loadModes = (file: string): Record<string, SessionModeEntry> => {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}

		// The reducer checks each entry (modes_loaded); here only the shape is kept.
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, SessionModeEntry] =>
					typeof entry[1] === 'object' && entry[1] !== null && typeof entry[1].mode === 'string',
			),
		);
	} catch {
		// A missing or corrupt file starts every session in Auto.
		return {};
	}
};

export const saveModes = (file: string, modes: Record<string, SessionModeEntry>): void => {
	writeJsonAtomic(file, modes);
};

interface PersistModesParams {
	store: Store;
	file: string;
}

export const persistModes = ({ store, file }: PersistModesParams): void => {
	let written = loadModes(file);
	let seen: Record<string, SessionModeEntry> = {};
	// Before the saved modes are merged, state.modes is only what was picked since boot: writing it
	// would lose the rest.
	let isLoaded = false;

	store.subscribe((stamped, state) => {
		const { input } = stamped;

		if (input.type === 'modes_loaded') {
			isLoaded = true;
		}

		// The reducer stays pure: every change, a pick or a plan approved, is read off the state it left.
		for (const ref of new Set([...Object.keys(seen), ...Object.keys(state.modes)])) {
			const from = seen[ref]?.mode ?? 'auto';
			const to = readMode(state, ref);

			if (from !== to) {
				log.info('mode set', {
					ref,
					from,
					to,
					by: input.type === 'set_mode' ? input.by : input.type,
				});
			}
		}

		seen = state.modes;

		if (input.type === 'mode_refused') {
			log.warn('mode refused', { ref: input.ref, mode: input.mode, kept: input.kept });
		}

		if (!isLoaded || JSON.stringify(state.modes) === JSON.stringify(written)) {
			return;
		}

		try {
			saveModes(file, state.modes);
			written = state.modes;
		} catch (error) {
			log.warn('modes not saved', { error: String(error) });
		}
	});

	store.dispatch({ type: 'modes_loaded', modes: written });
};
