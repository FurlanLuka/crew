import { describe, expect, it } from 'bun:test';
import { resolvePaths, shouldRecordState, shouldRecordVoice } from './config.js';

describe('shouldRecordVoice', () => {
	it('VOICEOS_RECORD_VOICE=1 → records; 0, yes, empty or unset → never', () => {
		expect(shouldRecordVoice({ VOICEOS_RECORD_VOICE: '1' })).toBe(true);

		for (const value of ['0', 'yes', '', undefined]) {
			expect(shouldRecordVoice({ VOICEOS_RECORD_VOICE: value })).toBe(false);
		}
	});

	it('recordings → beside the pack folder, never inside it (installing a pack clears that folder)', () => {
		const paths = resolvePaths({ HOME: '/h' });

		expect(paths.voiceRecordingsDir.startsWith(`${paths.voiceGateDir}/`)).toBe(false);
	});
});

describe('shouldRecordState', () => {
	it('launched by crew → records', () =>
		expect(shouldRecordState({ VOICEOS_RECORD_STATE: '1', PORT: '4000' })).toBe(true));
	it('manual run, even with a PORT → does not record', () =>
		expect(shouldRecordState({ PORT: '4000' })).toBe(false));
	it('flag set to anything else → does not record', () =>
		expect(shouldRecordState({ VOICEOS_RECORD_STATE: 'yes' })).toBe(false));
});
