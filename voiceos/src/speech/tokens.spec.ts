import { describe, expect, it } from 'bun:test';
import { buildContextTerms, TranscriptAccumulator } from './tokens.js';

describe('TranscriptAccumulator', () => {
	it('finals accumulate; the non-final tail is replaced each response', () => {
		const accumulator = new TranscriptAccumulator();
		accumulator.push([{ text: 'How', is_final: false }]);
		accumulator.push([
			{ text: 'How', is_final: true },
			{ text: ' are', is_final: false },
		]);
		accumulator.push([
			{ text: ' are', is_final: true },
			{ text: ' you', is_final: false },
		]);

		expect(accumulator.text).toBe('How are you');
		expect(accumulator.finalText).toBe('How are');
	});

	it('endpoint and finalize markers are not text', () => {
		const accumulator = new TranscriptAccumulator();
		accumulator.push([
			{ text: 'yes', is_final: true },
			{ text: '<end>', is_final: true },
			{ text: '<fin>', is_final: true },
		]);
		expect(accumulator.text).toBe('yes');
	});

	it('whitespace is collapsed', () => {
		const accumulator = new TranscriptAccumulator();
		accumulator.push([
			{ text: ' open ', is_final: true },
			{ text: '  wrk1', is_final: true },
		]);
		expect(accumulator.finalText).toBe('open wrk1');
	});
});

describe('TranscriptAccumulator in segment mode', () => {
	it('<end> closes a turn; the next one starts empty', () => {
		const accumulator = new TranscriptAccumulator({ isSegmented: true });
		expect(
			accumulator.push([
				{ text: 'go', is_final: true },
				{ text: ' home', is_final: true },
				{ text: '<end>', is_final: true },
			]),
		).toEqual({ isFinished: false, segments: ['go home'] });
		accumulator.push([{ text: 'open', is_final: false }]);
		expect(accumulator.text).toBe('open');
	});

	it('two turns in one batch → both, in order', () => {
		const accumulator = new TranscriptAccumulator({ isSegmented: true });
		const { segments } = accumulator.push([
			{ text: 'stop', is_final: true },
			{ text: '<end>', is_final: true },
			{ text: 'go home', is_final: true },
			{ text: '<end>', is_final: true },
		]);
		expect(segments).toEqual(['stop', 'go home']);
	});

	it('<end> with nothing final before it → no empty turn', () => {
		const accumulator = new TranscriptAccumulator({ isSegmented: true });
		expect(
			accumulator.push([
				{ text: '<end>', is_final: true },
				{ text: 'um', is_final: false },
			]).segments,
		).toEqual([]);
	});
});

describe('buildContextTerms', () => {
	it('refs and their parts as they are said, topics, deduplicated', () => {
		expect(
			buildContextTerms({
				refs: ['voiceos', 'store-front/main', 'store-front/wrk1'],
				topics: ['Checkout retries'],
			}),
		).toEqual([
			'Voice OS',
			'store front main',
			'store front',
			'main',
			'store front work 1',
			'work 1',
			'Checkout retries',
		]);
	});
});
