import { describe, expect, it } from 'bun:test';
import { type RingFrame, scoreTurn, speechInSpan, type TimedScore } from './turns.js';

const frame = (at: number, prob: number, isVoiceOsSpeaking = false): RingFrame => ({
	at,
	prob,
	isVoiceOsSpeaking,
	samples: new Float32Array(4).fill(at),
});

const score = (at: number, accepted: boolean): TimedScore => ({
	at,
	score: accepted ? 0.8 : 0.1,
	kind: 'first',
	accepted,
});

describe('speechInSpan', () => {
	const ring = [
		frame(100, 0.9),
		frame(200, 0.9),
		frame(300, 0.2),
		frame(400, 0.9, true),
		frame(500, 0.9),
		frame(600, 0.9),
	];

	it('speech frames inside the span → joined in order', () => {
		const speech = speechInSpan({ ring, from: 200, to: 500, speechOn: 0.5 });

		expect([...speech.audio].filter((_, index) => index % 4 === 0)).toEqual([200, 500]);
		expect(speech.frames).toBe(2);
	});

	it('quiet frames and frames outside the span → left out', () => {
		const speech = speechInSpan({ ring, from: 250, to: 350, speechOn: 0.5 });

		expect(speech.audio.length).toBe(0);
	});

	it('speech while Voice OS was speaking → skipped and counted', () => {
		const speech = speechInSpan({ ring, from: 0, to: 1000, speechOn: 0.5 });

		expect(speech.frames).toBe(4);
		expect(speech.skipped).toBe(1);
	});

	it('an empty ring → no audio', () => {
		expect(speechInSpan({ ring: [], from: 0, to: 1000, speechOn: 0.5 }).audio.length).toBe(0);
	});
});

describe('scoreTurn', () => {
	it('no scores in the turn → unscored', () => {
		expect(scoreTurn({ scores: [score(50, true)], from: 2000, to: 3000, padMs: 1000 })).toEqual({
			scores: [],
			verdict: 'unscored',
		});
	});

	it('accepted, then silenced before the end → silenced, both scores listed', () => {
		const scores = [score(1200, true), score(2200, false)];

		expect(scoreTurn({ scores, from: 1000, to: 3000, padMs: 0 })).toEqual({
			scores,
			verdict: 'silenced',
		});
	});

	it('a score in the padding before the turn → counts; one after the turn → does not', () => {
		const scores = [score(600, true), score(3500, false)];
		const turn = scoreTurn({ scores, from: 1000, to: 3000, padMs: 500 });

		expect(turn.verdict).toBe('kept');
		expect(turn.scores).toEqual([score(600, true)]);
	});

	it('a score exactly at the edges → counts', () => {
		const turn = scoreTurn({
			scores: [score(500, false), score(3000, true)],
			from: 1000,
			to: 3000,
			padMs: 500,
		});

		expect(turn.scores).toHaveLength(2);
	});
});
