// The pure parts of the comparison tool (scripts/voice-gate/eval-recordings.ts): its arguments, and
// the closing summary, one row per model.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { VariantResult } from './evaluate.js';

export interface EvalArgs {
	dir: string;
	packDir: string;
	candidatesDir: string;
}

export const parseEvalArgs = (argv: string[], home: string, packId: string): EvalArgs => {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { pack: { type: 'string' }, candidates: { type: 'string' } },
		allowPositionals: true,
	});
	const voiceDir = join(home, '.crew', 'voiceos');

	return {
		dir: positionals[0] ?? join(voiceDir, 'voice-recordings'),
		packDir: values.pack ?? join(voiceDir, 'voice-gate', packId),
		candidatesDir: values.candidates ?? join(voiceDir, 'voice-gate-candidates'),
	};
};

export interface ModelRun {
	model: string;
	results: VariantResult[];
	// Milliseconds per embed: the first decision's window, and the longest voiceprint piece.
	latency: { first: number; piece: number };
}

export interface SummaryRow {
	model: string;
	variant: string;
	// The model's operating point, which every variant was replayed at.
	threshold: number;
	eer: number | null;
	youP10: number | null;
	youMedian: number | null;
	othersP90: number | null;
	latency: ModelRun['latency'];
}

// A model's best variant is the one that tells the voices apart best on first decisions: lowest EER.
export const summaryRow = ({ model, results, latency }: ModelRun): SummaryRow | null => {
	const ranked = [...results].sort(
		(left, right) =>
			(left.eer?.rate ?? Number.POSITIVE_INFINITY) - (right.eer?.rate ?? Number.POSITIVE_INFINITY),
	);
	const best = ranked[0];

	if (!best) {
		return null;
	}

	return {
		model,
		variant: best.variant,
		threshold: best.threshold,
		eer: best.eer?.rate ?? null,
		youP10: best.you.p10,
		youMedian: best.you.median,
		othersP90: best.others.p90,
		latency,
	};
};
