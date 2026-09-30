import { describe, expect, it } from 'bun:test';
import { describeVoiceGate } from './voice-gate-chip.js';

describe('describeVoiceGate', () => {
	it('no status, unavailable, or loading models already on disk → no chip', () => {
		expect(describeVoiceGate(null)).toBeNull();
		expect(describeVoiceGate({ phase: 'unavailable' })).toBeNull();
		expect(describeVoiceGate({ phase: 'preparing', isDownloading: false })).toBeNull();
	});

	it('downloading → says so', () => {
		expect(describeVoiceGate({ phase: 'preparing', isDownloading: true })?.label).toBe(
			'voice models…',
		);
	});

	it('learning → hidden until the first second, then seconds of 30', () => {
		expect(describeVoiceGate({ phase: 'learning', seconds: 0, of: 30 })).toBeNull();
		expect(describeVoiceGate({ phase: 'learning', seconds: 12, of: 30 })?.label).toBe(
			'voice 12/30 s',
		);
	});

	it('past the target while the chunks still disagree → the real seconds, still learning', () => {
		expect(describeVoiceGate({ phase: 'learning', seconds: 41, of: 30 })?.label).toBe(
			'voice 41/30 s',
		);
	});

	it('scoring → the last turn’s score, or learned before any', () => {
		expect(describeVoiceGate({ phase: 'scoring', lastScore: 0.8234 })?.label).toBe('voice 0.82');
		expect(describeVoiceGate({ phase: 'scoring', lastScore: null })?.label).toBe('voice learned');
	});

	it('scoring → the hover says nothing is filtered', () => {
		expect(describeVoiceGate({ phase: 'scoring', lastScore: 0.5 })?.title).toContain(
			'Nothing is filtered yet',
		);
	});
});
