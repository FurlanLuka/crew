// The voice-lines eval: does Haiku word Voice OS's follow-ups and progress lines the way the app needs
// them — the label kept, the switch asked exactly when offered, short, and nothing invented? A
// measurement, never a gate. Every run bills the Anthropic key (a few cents: Haiku, ~20 cases).
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FollowUpFacts } from '../src/shared/follow-up.js';
import { stripTags } from '../src/shared/spoken.js';
import { INSTANT_ACK_POOL } from '../src/speech/instant-ack.js';
import {
	findFollowUpProblem,
	type FollowUpInput,
	type ProgressInput,
} from '../src/voice-lines/prompt.js';
import { wordFollowUp, wordProgress } from '../src/voice-lines/writer.js';
import { attempt, mapPool } from './pool.js';
import { countUsage, type RouteUsage } from './route.js';

interface CaseChecks {
	id: string;
	// Stems a line must contain ("a|b" accepts either).
	includes?: string[];
	// Words that would be invented, matched whole: never said.
	not_includes?: string[];
	// Words the line must not open with: what the ack just said.
	not_starts?: string[];
}

export type VoiceLineCase =
	| (CaseChecks & { kind: 'follow_up' } & FollowUpInput)
	| (CaseChecks & { kind: 'progress' } & ProgressInput);

export interface VoiceLineRow {
	id: string;
	kind: VoiceLineCase['kind'];
	// One per run: the line, and why it fails (null: it passes); null line when the call failed.
	runs: { line: string | null; problem: string | null; ms: number }[];
}

export const RUNS = 2;
const CONCURRENCY = 4;
// A worded line has a generous floor in the app; the eval holds it to this as well.
const TIMEOUT_MS = 10_000;

// Results nothing in the facts supports: a follow-up only says what Voice OS did.
const INVENTED_WORDS = ['done', 'finished', 'pass', 'fixed', 'seconds', 'minutes'];

const KINDS: FollowUpFacts['kind'][] = ['sent', 'queued', 'switching', 'back', 'activated'];

export const loadVoiceLineCases = (evalsDir: string): VoiceLineCase[] =>
	(
		JSON.parse(readFileSync(join(evalsDir, 'voice-lines', 'cases.json'), 'utf8')) as {
			cases: VoiceLineCase[];
		}
	).cases;

const toWords = (text: string): string =>
	` ${text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}']+/gu, ' ')
		.trim()} `;

const hasWords = (line: string, words: string): boolean => toWords(line).includes(toWords(words));

// Why a line fails its case beyond the app's own rules; null when it passes.
export const checkCaseLine = (testCase: VoiceLineCase, line: string): string | null => {
	// A stem is enough here: "search" is said as "searching" too.
	const missing = (testCase.includes ?? []).find(
		(option) => !option.split('|').some((stem) => line.toLowerCase().includes(stem)),
	);

	if (missing) {
		return `missing "${missing}"`;
	}

	const invented = [
		...(testCase.not_includes ?? []),
		...(testCase.kind === 'follow_up'
			? INVENTED_WORDS.filter((word) => !hasWords(testCase.fixedText, word))
			: []),
	].find((words) => hasWords(line, words));

	if (invented) {
		return `invented "${invented}"`;
	}

	if (testCase.kind === 'follow_up' && /\d/.test(line) && !/\d/.test(testCase.fixedText)) {
		return 'invented a number';
	}

	const opener = (testCase.not_starts ?? []).find((words) =>
		toWords(line).startsWith(toWords(words)),
	);

	return opener ? `opens with "${opener}" again` : null;
};

// The repo's cases checked for free before any paid call: each must be one the app could send.
export const findVoiceLineCaseProblems = (cases: VoiceLineCase[]): string[] => {
	const seen = new Set<string>();
	// The writer is told the ack as heard, without its voice tags.
	const pool = INSTANT_ACK_POOL.map((line) => stripTags(line.text));

	return cases.flatMap((testCase): string[] => {
		const problems: string[] = [];

		if (seen.has(testCase.id)) {
			problems.push(`${testCase.id}: id used twice`);
		}

		seen.add(testCase.id);

		if (testCase.kind === 'follow_up') {
			if (!KINDS.includes(testCase.facts.kind)) {
				problems.push(`${testCase.id}: facts kind ${testCase.facts.kind} is not one the app sends`);
			}

			// The fixed line is the fallback: it keeps the rules the worded one is held to.
			const fixedProblem = findFollowUpProblem(testCase.fixedText, testCase.facts);

			if (fixedProblem) {
				problems.push(`${testCase.id}: its fixed line breaks a rule (${fixedProblem})`);
			}

			if (testCase.lastAck !== null && !pool.includes(testCase.lastAck)) {
				problems.push(`${testCase.id}: lastAck "${testCase.lastAck}" is not a pool line`);
			}
		} else if (testCase.kind === 'progress') {
			if (testCase.step === null && testCase.agents.length === 0) {
				problems.push(`${testCase.id}: no step and no agents — the app says nothing then`);
			}

			// The app only ever passes the spoken form: never a path.
			if (testCase.step?.includes('/')) {
				problems.push(`${testCase.id}: step "${testCase.step}" is a raw path`);
			}
		} else {
			problems.push(`${(testCase as { id: string }).id}: kind is not follow_up or progress`);
		}

		return problems;
	});
};

export interface VoiceLineScore {
	n: number;
	passRate: number;
	infraErrors: number;
	medianMs: number;
}

export const scoreVoiceLines = (rows: VoiceLineRow[]): VoiceLineScore => {
	const runs = rows.flatMap((row) => row.runs);
	const answered = runs.filter((run) => run.line !== null);
	const ms = answered.map((run) => run.ms).sort((left, right) => left - right);

	return {
		n: answered.length,
		passRate: answered.filter((run) => run.problem === null).length / Math.max(1, answered.length),
		infraErrors: runs.length - answered.length,
		medianMs: ms[Math.floor(ms.length / 2)] ?? 0,
	};
};

interface RunVoiceLinesEvalParams {
	apiKey: string;
	evalsDir: string;
	usage: RouteUsage;
	onlyIds?: Set<string> | null;
}

export const runVoiceLinesEval = async ({
	apiKey,
	evalsDir,
	usage,
	onlyIds = null,
}: RunVoiceLinesEvalParams): Promise<VoiceLineRow[]> => {
	const all = loadVoiceLineCases(evalsDir);
	const problems = findVoiceLineCaseProblems(all);

	if (problems.length > 0) {
		throw new Error(`voice-lines cases:\n${problems.join('\n')}`);
	}

	const cases = onlyIds ? all.filter((testCase) => onlyIds.has(testCase.id)) : all;

	if (onlyIds && cases.length !== onlyIds.size) {
		const known = new Set(all.map((testCase) => testCase.id));

		throw new Error(`unknown case ids: ${[...onlyIds].filter((id) => !known.has(id)).join(', ')}`);
	}

	const client = countUsage(new Anthropic({ apiKey, maxRetries: 2, timeout: 30_000 }), usage);
	const jobs = cases.flatMap((testCase) => Array.from({ length: RUNS }, () => testCase));
	const runs = await mapPool(jobs, CONCURRENCY, async (testCase) => {
		const startedAt = Date.now();
		const result = await attempt(() =>
			testCase.kind === 'follow_up'
				? wordFollowUp(testCase, { client, timeoutMs: TIMEOUT_MS })
				: wordProgress(testCase, { client, timeoutMs: TIMEOUT_MS }),
		);
		const ms = Date.now() - startedAt;

		return result.ok
			? {
					id: testCase.id,
					line: result.value.text,
					problem: result.value.problem ?? checkCaseLine(testCase, result.value.text),
					ms,
				}
			: { id: testCase.id, line: null, problem: result.error, ms };
	});

	return cases.map((testCase) => ({
		id: testCase.id,
		kind: testCase.kind,
		runs: runs
			.filter((run) => run.id === testCase.id)
			.map(({ line, problem, ms }) => ({ line, problem, ms })),
	}));
};
