import { describe, expect, it } from 'bun:test';
import { shouldRecordState } from './config.js';

describe('shouldRecordState', () => {
	it('launched by crew → records', () =>
		expect(shouldRecordState({ VOICEOS_RECORD_STATE: '1', PORT: '4000' })).toBe(true));
	it('manual run, even with a PORT → does not record', () =>
		expect(shouldRecordState({ PORT: '4000' })).toBe(false));
	it('flag set to anything else → does not record', () =>
		expect(shouldRecordState({ VOICEOS_RECORD_STATE: 'yes' })).toBe(false));
});
