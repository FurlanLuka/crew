// Replays the voice gate's recordings (VOICEOS_RECORD_VOICE=1) through each speaker model, voiceprint
// and decision rule, and prints which tells your voice from everyone else's best.
//
//   bun scripts/voice-gate/eval-recordings.ts [recordings dir] [--pack <pack dir>] [--candidates <dir>]
//
// Defaults: ~/.crew/voiceos/voice-recordings, ~/.crew/voiceos/voice-gate/<pack id> (ECAPA and the
// runtime) and ~/.crew/voiceos/voice-gate-candidates (every other model, from export_candidates.py).
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
	evaluate,
	operatingPoint,
	readRecordings,
	type VariantResult,
} from '../../src/voice-gate/evaluate.js';
import { SAMPLE_RATE } from '../../src/voice-gate/gate.js';
import { type Embed, loadEmbedModel, loadModels } from '../../src/voice-gate/models.js';
import { PACK_MANIFEST } from '../../src/voice-gate/pack.js';
import { type ModelRun, parseEvalArgs, summaryRow } from '../../src/voice-gate/eval-report.js';

// The gate embeds a window about once a second while you speak: a model slower than this falls behind.
const WINDOW_BUDGET_MS = 1_000;

const { dir, packDir, candidatesDir } = parseEvalArgs(
	process.argv.slice(2),
	homedir(),
	PACK_MANIFEST.id,
);
const recordings = readRecordings(dir, (name, error) =>
	console.warn(`skipped ${name}: ${String(error)}`),
);
const fixed = (value: number | null) => (value === null ? '  -  ' : value.toFixed(2));
const percent = (value: number) => `${Math.round(value * 100)}%`.padStart(4);

console.log(
	`${recordings.length} recordings: ${recordings.filter((r) => r.label === 'turn').length} turn, ${recordings.filter((r) => r.label === 'other').length} other`,
);

// Inference time does not depend on what is said: noise of the right length measures it.
const timeEmbed = async (embed: Embed, seconds: number): Promise<number> => {
	const audio = Float32Array.from(
		{ length: seconds * SAMPLE_RATE },
		() => Math.random() * 0.1 - 0.05,
	);
	const runs: number[] = [];

	await embed(audio);

	for (let run = 0; run < 10; run++) {
		const started = performance.now();

		await embed(audio);
		runs.push(performance.now() - started);
	}

	return runs.sort((left, right) => left - right)[5] ?? 0;
};

const models: { name: string; load: () => Promise<Embed> }[] = [
	{ name: 'ecapa', load: async () => (await loadModels(packDir)).embed },
];

if (existsSync(candidatesDir)) {
	for (const file of readdirSync(candidatesDir)
		.filter((name) => name.endsWith('.onnx'))
		.sort()) {
		models.push({
			name: file.slice(0, -'.onnx'.length),
			load: () => loadEmbedModel(packDir, join(candidatesDir, file)),
		});
	}
} else {
	console.log(
		`\nNo candidate models in ${candidatesDir}. To compare CAM++ and WavLM too, run the command in the header of scripts/voice-gate/export_candidates.py.`,
	);
}

const printTables = (results: VariantResult[]) => {
	console.log('\nFirst decision scores (the weak spot): you vs other voices');
	console.log(
		'variant              you n  p10  median | others n median  p90 |  EER | your speech silenced',
	);

	for (const result of results) {
		console.log(
			`${result.variant.padEnd(20)} ${String(result.you.count).padStart(5)} ${fixed(result.you.p10)} ${fixed(result.you.median)}  | ${String(result.others.count).padStart(8)} ${fixed(result.others.median)}  ${fixed(result.others.p90)} | ${result.eer === null ? '  - ' : percent(result.eer.rate)} | ${percent(result.yourSpeechSilenced)}`,
		);
	}

	console.log('\nLater windows (medians) and your first decision by how you spoke');

	for (const result of results) {
		console.log(
			`${result.variant.padEnd(20)} rechecks you ${fixed(result.rechecks.you)} others ${fixed(result.rechecks.others)} | first: push ${fixed(result.bySource.push)} listened ${fixed(result.bySource.listened)}`,
		);
	}

	console.log('\nPer threshold: your utterances starting silenced / other voices starting let in');

	for (const result of results) {
		console.log(
			`${result.variant.padEnd(20)} ${result.atThresholds
				.map(
					(row) =>
						`${row.threshold.toFixed(2)}: ${percent(row.youMissed)} / ${percent(row.othersLetIn)}`,
				)
				.join('   ')}`,
		);
	}

	console.log('\nHighest-scoring "other" recordings (listen: some may be you talking to someone):');

	for (const other of results[0]?.topOthers ?? []) {
		console.log(`  ${other.score.toFixed(2)}  ${join(dir, `${other.name}.wav`)}`);
	}
};

const runs: ModelRun[] = [];

for (const { name, load } of models) {
	let embed: Embed;

	try {
		embed = await load();
	} catch (error) {
		console.warn(`\nskipped model ${name}: ${String(error)}`);
		continue;
	}

	const latency = { first: await timeEmbed(embed, 0.8), piece: await timeEmbed(embed, 3) };
	const threshold = await operatingPoint(recordings, embed);

	console.log(
		`\n=== model ${name}: ${latency.first.toFixed(0)} ms per 0.8 s window, ${latency.piece.toFixed(0)} ms per 3 s piece; judged at ${threshold === null ? 'the default threshold (too few recordings for its own)' : threshold.toFixed(2)}`,
	);

	const results = await evaluate(recordings, embed, threshold === null ? {} : { threshold });

	printTables(results);
	runs.push({ model: name, results, latency });
}

console.log(
	'\n=== Summary: each model at its best variant, judged at its own threshold (picked on these recordings: fair for ranking, not a live threshold; the 0.05 flip margin is the same for all)',
);
console.log(
	'model        variant              judged at   EER | you p10 median | others p90 | ms 0.8 s  ms 3 s',
);

for (const row of runs.map(summaryRow)) {
	if (row) {
		const slow = row.latency.first > WINDOW_BUDGET_MS ? ' (slower than the gate’s windows)' : '';

		console.log(
			`${row.model.padEnd(12)} ${row.variant.padEnd(20)} ${row.threshold.toFixed(2).padStart(9)} ${row.eer === null ? '  - ' : percent(row.eer)} | ${fixed(row.youP10)}   ${fixed(row.youMedian)} |      ${fixed(row.othersP90)} | ${row.latency.first.toFixed(0).padStart(8)} ${row.latency.piece.toFixed(0).padStart(7)}${slow}`,
		);
	}
}
