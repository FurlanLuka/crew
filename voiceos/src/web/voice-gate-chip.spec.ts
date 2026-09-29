import { describe, expect, it } from 'bun:test';
import { describeVoiceGate } from './voice-gate-chip.js';

describe('describeVoiceGate', () => {
	it('no status, unavailable, or loading models already on disk → no chip', () => {
		expect(describeVoiceGate(null)).toBeNull();
		expect(describeVoiceGate({ phase: 'unavailable' })).toBeNull();
		expect(describeVoiceGate({ phase: 'preparing', isDownloading: false })).toBeNull();
	});

	it('downloading → says so, nothing to forget', () => {
		expect(describeVoiceGate({ phase: 'preparing', isDownloading: true })).toMatchObject({
			label: 'voice models…',
			canForget: false,
		});
	});

	it('learning → seconds of the target, shown from 0 so a forget visibly starts over', () => {
		expect(describeVoiceGate({ phase: 'learning', seconds: 0, of: 30 })?.label).toBe(
			'voice 0/30 s',
		);
		expect(describeVoiceGate({ phase: 'learning', seconds: 41, of: 30 })).toMatchObject({
			label: 'voice 41/30 s',
			canForget: false,
		});
	});

	it('scoring, not trained yet → the last score, still learning; it can be forgotten', () => {
		expect(
			describeVoiceGate({ phase: 'scoring', lastScore: 0.6412, average: 0.72, isTrained: false }),
		).toMatchObject({ label: 'voice 0.64 · learning', canForget: true });
		expect(
			describeVoiceGate({ phase: 'scoring', lastScore: null, average: null, isTrained: false })
				?.label,
		).toBe('voice · learning');
	});

	it('trained → just the score (it keeps learning, slowly)', () => {
		const chip = describeVoiceGate({
			phase: 'scoring',
			lastScore: 0.83,
			average: 0.84,
			isTrained: true,
		});

		expect(chip?.label).toBe('voice 0.83');
		expect(chip?.title).toContain('keeps learning, slowly');
	});

	it('scoring → the hover gives the average, says nothing is filtered, and offers to forget', () => {
		const title = describeVoiceGate({
			phase: 'scoring',
			lastScore: 0.5,
			average: 0.72,
			isTrained: false,
		})?.title;

		expect(title).toContain('average 0.72');
		expect(title).toContain('Nothing is filtered yet');
		expect(title).toContain('last 10 turns all reach 0.6');
		expect(title).toContain('forget your voice');
	});

	it('trained, no turn scored yet this run → learned', () => {
		expect(
			describeVoiceGate({ phase: 'scoring', lastScore: null, average: 0.85, isTrained: true })
				?.label,
		).toBe('voice learned');
	});
});
