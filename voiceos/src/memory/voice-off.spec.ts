import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../state/store.js';
import { configureLog } from '../log.js';
import { loadVoiceOff, persistVoiceOff } from './voice-off.js';

configureLog({ quiet: true });

const scratch = () => join(mkdtempSync(join(tmpdir(), 'voiceos-voice-off-')), 'voice-off.json');

describe('voice off', () => {
	it('no file, or a broken one → voice on', () => {
		const file = scratch();

		expect(loadVoiceOff(file)).toBe(false);
		writeFileSync(file, '{not json');
		expect(loadVoiceOff(file)).toBe(false);
	});

	it('loaded into the state at boot; a change is written back', () => {
		const file = scratch();
		writeFileSync(file, JSON.stringify({ voiceOff: true }));
		const store = new Store();

		persistVoiceOff({ store, file });
		expect(store.state.voiceOff).toBe(true);

		store.dispatch({ type: 'set_voice_off', voiceOff: false });
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ voiceOff: false });
	});
});
