import { describe, expect, it } from 'bun:test';
import { parseEvalArgs, summaryRow } from './eval-report.js';
import type { VariantResult } from './evaluate.js';

const HOME = '/home/dev';
const parse = (argv: string[]) => parseEvalArgs(argv, HOME, 'pack-1');

const DEFAULTS = {
	dir: '/home/dev/.crew/voiceos/voice-recordings',
	packDir: '/home/dev/.crew/voiceos/voice-gate/pack-1',
	candidatesDir: '/home/dev/.crew/voiceos/voice-gate-candidates',
};

describe('parseEvalArgs', () => {
	it('nothing given → the recordings, pack and candidates under ~/.crew/voiceos', () => {
		expect(parse([])).toEqual(DEFAULTS);
	});

	it('--pack alone → the pack, the recordings dir still the default', () => {
		expect(parse(['--pack', '/p'])).toEqual({ ...DEFAULTS, packDir: '/p' });
	});

	it('--candidates alone → its folder is not taken for the recordings', () => {
		expect(parse(['--candidates', '/c'])).toEqual({ ...DEFAULTS, candidatesDir: '/c' });
	});

	it('the recordings dir before or after the flags → the same', () => {
		const expected = { dir: '/r', packDir: '/p', candidatesDir: '/c' };

		expect(parse(['/r', '--pack', '/p', '--candidates', '/c'])).toEqual(expected);
		expect(parse(['--pack', '/p', '--candidates', '/c', '/r'])).toEqual(expected);
	});
});

const result = (variant: string, eer: number | null): VariantResult => ({
	variant,
	threshold: 0.7,
	you: { count: 3, p10: 0.8, median: 0.9 },
	others: { count: 3, median: 0.3, p90: 0.5 },
	atThresholds: [],
	eer: eer === null ? null : { rate: eer, threshold: 0.7 },
	rechecks: { you: null, others: null },
	bySource: { push: null, listened: null },
	yourSpeechSilenced: 0,
	topOthers: [],
});

const latency = { first: 12, piece: 30 };

describe('summaryRow', () => {
	it('several variants → the one with the lowest EER, with its numbers', () => {
		expect(
			summaryRow({
				model: 'campplus',
				results: [result('today', 0.2), result('decide at 1.2 s', 0.05), result('none', null)],
				latency,
			}),
		).toEqual({
			model: 'campplus',
			variant: 'decide at 1.2 s',
			threshold: 0.7,
			eer: 0.05,
			youP10: 0.8,
			youMedian: 0.9,
			othersP90: 0.5,
			latency,
		});
	});

	it('no variant with an EER (no other voices recorded) → the first, EER empty', () => {
		const row = summaryRow({
			model: 'ecapa',
			results: [result('today', null), result('decide at 1.2 s', null)],
			latency,
		});

		expect(row?.variant).toBe('today');
		expect(row?.eer).toBeNull();
	});

	it('no results → no row', () => {
		expect(summaryRow({ model: 'ecapa', results: [], latency })).toBeNull();
	});
});
