// The judge on real words in four languages: `bun evals/judge.ts [--only=key,key]`. Bills the
// Anthropic key (one small Haiku call per case, a few cents a run); run locally, never in CI.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKeys, resolvePaths } from '../src/config.js';
import { configureLog } from '../src/log.js';
import { createJudge, type JudgeKey } from '../src/judge/judge.js';

interface JudgeCase {
	key: JudgeKey;
	utterance: string;
	context?: string;
	expect: string;
}

configureLog({ quiet: true });
const apiKey = loadKeys(resolvePaths()).anthropic;

if (!apiKey) {
	console.error('No Anthropic key');
	process.exit(2);
}

const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const onlyKeys = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;
const { cases } = JSON.parse(
	readFileSync(join(import.meta.dir, 'judge', 'cases.json'), 'utf8'),
) as { cases: JudgeCase[] };
const judge = createJudge({ apiKey, timeoutMs: 10_000 });
const picked = cases.filter((testCase) => !onlyKeys || onlyKeys.has(testCase.key));
const results = await Promise.all(
	picked.map(async (testCase) => ({
		...testCase,
		got: await judge({
			key: testCase.key,
			utterance: testCase.utterance,
			...(testCase.context ? { context: testCase.context } : {}),
		}),
	})),
);
// "yes|unclear": either answer leads the guard to the same action.
const failed = results.filter((result) => !result.expect.split('|').includes(result.got));

for (const result of failed) {
	console.log(
		`  ✗ ${result.key}: "${result.utterance}" → ${result.got} (expected ${result.expect})`,
	);
}

console.log(`judge: ${results.length - failed.length}/${results.length} cases pass`);
process.exit(failed.length > 0 ? 1 : 0);
