// Prompt evals. `bun evals/run.ts [narrator|kernel|all|route|voice-lines] [--only=id,id] [--system=kernel|classifier|both] [--narrator-model=id] [--kernel-model=id] [--update-baseline]`.
// Every run bills the Anthropic key: iterate with --only (no scores, no baseline), full suite before review.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKeys, resolvePaths } from '../src/config.js';
import { configureLog } from '../src/log.js';
import { createNarrator } from '../src/narrator/narrator.js';
import {
	RUNS as NARRATOR_RUNS,
	runJudgeCalibration,
	runNarratorEval,
	scoreNarrator,
} from './narrator.js';

configureLog({ quiet: true });
const evalsDir = import.meta.dir;
const suite = process.argv[2] ?? 'all';
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const onlyIds = onlyArg
	? new Set(onlyArg.slice('--only='.length).split(',').filter(Boolean))
	: null;
// Compares the narrator on another model; its scores never become the baseline.
const kernelModel = process.argv
	.find((arg) => arg.startsWith('--kernel-model='))
	?.slice('--kernel-model='.length);
const narratorModel = process.argv
	.find((arg) => arg.startsWith('--narrator-model='))
	?.slice('--narrator-model='.length);
const shouldUpdateBaseline =
	process.argv.includes('--update-baseline') && !onlyIds && !narratorModel && !kernelModel;
const apiKey = loadKeys(resolvePaths()).anthropic;

if (!apiKey) {
	console.error(
		'No Anthropic key (~/.config/crew-voiceos/anthropic.key or VOICEOS_ANTHROPIC_API_KEY)',
	);
	process.exit(2);
}

const baselineFile = join(evalsDir, 'baseline.json');
const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<
	string,
	Record<string, number>
>;
// Absolute floors; the committed baseline catches regressions smaller than a floor.
const THRESHOLDS: Record<string, Record<string, number>> = {
	narrator: {
		needsUser: 0.9,
		speak: 0.85,
		format: 1,
		faithful: 0.9,
		holdoutNeedsUser: 0.85,
		judgeCalibration: 1,
	},
	kernel: { overall: 0.9, mutating: 1 },
};
const REGRESSION_TOLERANCE = 0.05;

// More failing calls than this means the run measured the network, not the prompts.
const MAX_INFRA_ERRORS = 0.1;

const failures: string[] = [];
const results: Record<string, unknown> = {};
const scores: Record<string, Record<string, number>> = {};

const checkScore = (name: string, score: Record<string, number>): void => {
	// A handful of cases is not a score: pass or fail is per case, printed above.
	if (onlyIds) {
		return;
	}

	scores[name] = score;

	for (const [metric, floor] of Object.entries(THRESHOLDS[name] ?? {})) {
		const value = score[metric] ?? 0;
		const baselineValue = baseline[name]?.[metric];
		const isBelowFloor = value < floor;
		const hasRegressed =
			baselineValue !== undefined && value < baselineValue - REGRESSION_TOLERANCE;
		const mark = isBelowFloor || hasRegressed ? '✗' : '✓';
		console.log(
			`${mark} ${name}.${metric} = ${value.toFixed(3)}  (floor ${floor}${baselineValue !== undefined ? `, baseline ${baselineValue.toFixed(3)}` : ''})`,
		);

		if (isBelowFloor || hasRegressed) {
			failures.push(`${name}.${metric}`);
		}
	}
};

if (suite === 'narrator' || suite === 'all') {
	const calibration = onlyIds
		? { accuracy: 1, misses: [] }
		: await runJudgeCalibration(apiKey, evalsDir);

	if (!onlyIds) {
		console.log(
			`judge calibration ${calibration.accuracy.toFixed(2)}${calibration.misses.length ? ` — misses: ${calibration.misses.join(', ')}` : ''}`,
		);
	}

	const rows = await runNarratorEval({
		narrate: createNarrator(apiKey, narratorModel),
		judgeKey: apiKey,
		evalsDir,
		onlyIds,
	});

	if (onlyIds) {
		const failingRows = rows.filter(
			(row) => !row.needsUserOk || !row.speakOk || !row.formatOk || row.faithful === false,
		);
		console.log(`narrator: ${rows.length - failingRows.length}/${rows.length} cases pass`);

		if (failingRows.length > 0) {
			failures.push('narrator cases');
		}
	}

	results.narrator = rows;

	for (const split of ['dev', 'holdout']) {
		const splitScore = scoreNarrator(rows.filter((row) => row.split === split));
		console.log(
			`narrator ${split}: needs_user ${splitScore.needsUser.toFixed(2)} · speak ${splitScore.speak.toFixed(2)} · faithful ${splitScore.faithful.toFixed(2)} (n=${splitScore.n})`,
		);
	}

	for (const row of rows.filter(
		(candidate) =>
			!candidate.needsUserOk ||
			!candidate.speakOk ||
			!candidate.formatOk ||
			candidate.faithful === false,
	)) {
		console.log(
			`  ✗ ${row.id}: needs_user ${row.needsUserOk ? 'ok' : 'WRONG'}, speak ${row.speakOk ? 'ok' : 'WRONG'}, format ${row.formatOk ? 'ok' : 'BAD'}, faithful ${row.faithful} — "${row.spoken}" ${row.judgeReason ? `(${row.judgeReason})` : ''}`,
		);
	}

	const { needsUser, speak, format, faithful, infraErrors } = scoreNarrator(rows);
	const holdoutNeedsUser = scoreNarrator(rows.filter((row) => row.split === 'holdout')).needsUser;

	if (infraErrors / (rows.length * NARRATOR_RUNS) > MAX_INFRA_ERRORS) {
		console.log(`✗ narrator: ${infraErrors} API failures — infrastructure, not a score`);
		failures.push('narrator infrastructure');
	}

	checkScore('narrator', {
		needsUser,
		speak,
		format,
		faithful,
		holdoutNeedsUser,
		judgeCalibration: calibration.accuracy,
	});
}

if (suite === 'kernel' || suite === 'all') {
	const { runKernelEval } = await import('./kernel.js');
	const kernelEval = await runKernelEval({ apiKey, evalsDir, onlyIds, model: kernelModel });
	results.kernel = kernelEval.rows;

	if (onlyIds) {
		const failingRows = kernelEval.rows.filter(
			(row) => row.runs.length === 0 || row.passes < row.needed,
		);
		console.log(
			`kernel: ${kernelEval.rows.length - failingRows.length}/${kernelEval.rows.length} cases pass`,
		);

		if (failingRows.length > 0) {
			failures.push('kernel cases');
		}
	}

	if ((kernelEval.score.infraErrors ?? 0) > MAX_INFRA_ERRORS) {
		console.log(
			`✗ kernel: ${((kernelEval.score.infraErrors ?? 0) * 100).toFixed(0)}% API failures — infrastructure, not a score`,
		);
		failures.push('kernel infrastructure');
	}

	checkScore('kernel', kernelEval.score);
}

// The route decision on a session's screen, by today's kernel and by a narrow classifier: a measurement,
// not a gate — it never fails the run, and its scores never reach the baseline.
if (suite === 'route') {
	const { costOf, emptyUsage, parseRouteSystems, runRouteEval, scoreRoute } = await import(
		'./route.js'
	);
	const systems = parseRouteSystems(
		process.argv.find((arg) => arg.startsWith('--system='))?.slice('--system='.length),
	);

	// Its cost line prices Haiku, and it has no baseline: refuse what would mislead.
	if (kernelModel || narratorModel || process.argv.includes('--update-baseline')) {
		throw new Error(
			'route runs the live models and has no baseline: drop --kernel-model, --narrator-model, --update-baseline',
		);
	}

	for (const system of systems) {
		const usage = emptyUsage();
		const rows = await runRouteEval({ apiKey, evalsDir, system, onlyIds, usage });
		const score = scoreRoute(rows);
		results[`route-${system}`] = { score, rows };
		console.log(
			`route ${system} usage: ${usage.calls} API calls · ${usage.input} in · ${usage.cacheRead} cache read · ${usage.cacheWrite} cache write · ${usage.output} out ≈ $${costOf(usage).toFixed(3)} (${rows.length} cases, $${(costOf(usage) / Math.max(1, rows.length)).toFixed(4)} each)`,
		);
		console.log(
			`route ${system}: accuracy ${score.accuracy.toFixed(3)} (n=${score.n}) · leaked ${score.leaked} · swallowed ${score.swallowed} · unclear ${score.unclear} · ${score.medianMs} ms median, ${score.p90Ms} ms p90${score.infraErrors ? ` · ${score.infraErrors} API failures` : ''}`,
		);

		// The kernel prompt was tuned on its own cases: the speech and pairs splits are the honest ones.
		for (const source of ['kernel', 'pairs', 'speech'] as const) {
			const split = scoreRoute(rows.filter((row) => row.source === source));

			if (split.n > 0) {
				console.log(
					`  ${source}: ${split.accuracy.toFixed(3)} (n=${split.n}) · leaked ${split.leaked} · swallowed ${split.swallowed} · unclear ${split.unclear}`,
				);
			}
		}

		for (const row of rows.filter(
			(candidate) => candidate.decision !== null && candidate.decision !== candidate.label,
		)) {
			console.log(
				`  ✗ ${row.id}: ${row.label} → ${row.decision}${row.calls.length ? ` (${row.calls.join(', ')})` : ''}`,
			);
		}
	}
}

// Haiku's worded follow-ups: a measurement like route, never in `all`, never a gate.
if (suite === 'voice-lines') {
	const { costOf, emptyUsage } = await import('./route.js');
	const { runVoiceLinesEval, scoreVoiceLines } = await import('./voice-lines.js');

	// Its cost line prices Haiku, and it has no baseline: refuse what would mislead.
	if (kernelModel || narratorModel || process.argv.includes('--update-baseline')) {
		throw new Error(
			'voice-lines runs Haiku and has no baseline: drop --kernel-model, --narrator-model, --update-baseline',
		);
	}

	const usage = emptyUsage();
	const rows = await runVoiceLinesEval({ apiKey, evalsDir, usage, onlyIds });
	const score = scoreVoiceLines(rows);
	results['voice-lines'] = { score, rows };
	console.log(
		`voice-lines usage: ${usage.calls} API calls · ${usage.input} in · ${usage.output} out ≈ $${costOf(usage).toFixed(3)}`,
	);
	console.log(
		`voice-lines: pass ${score.passRate.toFixed(3)} (n=${score.n}) · ${score.medianMs} ms median${score.infraErrors ? ` · ${score.infraErrors} API failures` : ''}`,
	);

	for (const row of rows) {
		for (const run of row.runs.filter((candidate) => candidate.problem !== null)) {
			console.log(`  ✗ ${row.id}: ${run.problem} — "${run.line ?? ''}"`);
		}
	}
}

mkdirSync(join(evalsDir, 'results'), { recursive: true });
writeFileSync(
	join(evalsDir, 'results', `${suite}-${Date.now()}.json`),
	JSON.stringify({ scores, results }, null, 2),
);

if (shouldUpdateBaseline) {
	writeFileSync(baselineFile, `${JSON.stringify({ ...baseline, ...scores }, null, 2)}\n`);
	console.log('baseline updated');
}

if (failures.length > 0) {
	console.log(`✗ failed: ${failures.join(', ')}`);
}

process.exit(failures.length > 0 ? 1 : 0);
