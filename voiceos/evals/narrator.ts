import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { NarrateFunction } from '../src/narrator/narrator.js';
import { toSpokenName } from '../src/shared/spoken.js';
import { attempt, mapPool } from './pool.js';

interface Case {
	id: string;
	split: 'dev' | 'holdout';
	label: string;
	asked: string | null;
	focused: boolean;
	text: string;
	expect: { needs_user: boolean; speak: boolean };
	// A direct question gets just the answer: no more words than this.
	max_words?: number;
	// Words that must not be spoken: a question's options from earlier sentences.
	not_includes?: string[];
}

// Narration is unsolicited: short, and shorter still for the session on screen.
export const NARRATION_WORDS = 20;
export const FOCUSED_WORDS = 12;

interface CalibrationCase {
	id: string;
	label: string;
	needs_user: boolean;
	text: string;
	spoken: string;
	faithful: boolean;
}

export const RUNS = 3;
const CONCURRENCY = 4;

export interface NarratorRow {
	id: string;
	split: string;
	needsUserOk: boolean;
	speakOk: boolean;
	formatOk: boolean;
	faithful: boolean | null;
	spoken: string;
	judgeReason: string;
	infraErrors: number;
}

interface NarratorRun {
	needsUser: boolean;
	speak: boolean;
	format: boolean;
	faithful: boolean | null;
	spoken: string;
	reason: string;
}

// Pinned so a judge upgrade cannot silently move the score.
export const JUDGE_MODEL = 'claude-sonnet-5';

const verdictSchema = z.object({ faithful: z.boolean(), reason: z.string() });

interface JudgeVerdict {
	faithful: boolean;
	reason: string;
}

const JUDGE_PROMPT = `You check a line that a voice assistant spoke about a coding session (its name is given to you; the line may leave it out). Answer faithful=true only if every claim in the spoken line is supported by the session text, and — when the session is waiting on the developer — the line conveys what it is waiting for well enough to answer without reading the screen. Details taken from what the developer asked count as supported. Paraphrase and omission of detail are fine; invented results, wrong numbers, or a wrong question are not. When the session offers a choice, the line deliberately names only what is being chosen and ends with "say options to hear them" (the developer asks Voice OS for the options) — that is not an invented claim, and it conveys the choice well enough.`;

const loadCases = <T>(dir: string, file: string): T[] => {
	return (JSON.parse(readFileSync(join(dir, 'narrator', file), 'utf8')) as { cases: T[] }).cases;
};

export interface IsFormatOkParams {
	spoken: string;
	label: string;
	speak: boolean;
	maxWords?: number;
	notIncludes?: string[];
}

export const isFormatOk = ({
	spoken,
	label,
	speak,
	maxWords = NARRATION_WORDS,
	notIncludes = [],
}: IsFormatOkParams): boolean => {
	if (!speak) {
		return true;
	}

	const words = spoken.split(/\s+/).filter(Boolean);
	const lowerSpoken = spoken.toLowerCase();
	// Voice OS adds the session name when it is not on screen, so a line that names it says it twice.
	const isNamed =
		lowerSpoken.startsWith(toSpokenName(label).toLowerCase()) ||
		lowerSpoken.startsWith(label.toLowerCase());
	const hasListedPhrase = notIncludes.some((phrase) => lowerSpoken.includes(phrase.toLowerCase()));

	return (
		words.length > 0 &&
		words.length <= maxWords &&
		!isNamed &&
		!hasListedPhrase &&
		!/[`]|https?:\/\//.test(spoken)
	);
};

interface JudgeLineParams {
	label: string;
	text: string;
	needsUser: boolean;
	spoken: string;
	asked: string | null;
}

const judgeLine = async (
	judge: Anthropic,
	{ label, text, needsUser, spoken, asked }: JudgeLineParams,
): Promise<JudgeVerdict> => {
	const response = await judge.messages.parse({
		model: JUDGE_MODEL,
		max_tokens: 800,
		system: JUDGE_PROMPT,
		messages: [
			{
				role: 'user',
				content: `Session name: ${label} (spoken as "${toSpokenName(label)}")\n\nThe developer had asked: ${asked ?? '(unknown)'}\n\nSession text:\n${text}\n\nWaiting on the developer: ${needsUser ? 'yes' : 'no'}\n\nSpoken line:\n${spoken}`,
			},
		],
		output_config: { format: zodOutputFormat(verdictSchema) },
	});

	if (!response.parsed_output) {
		throw new Error(`judge returned no verdict (${response.stop_reason})`);
	}

	return response.parsed_output;
};

const isMajority = (votes: boolean[]) => votes.filter(Boolean).length * 2 > votes.length;

interface RunNarratorEvalParams {
	narrate: NarrateFunction;
	judgeKey: string;
	evalsDir: string;
	onlyIds?: Set<string> | null;
}

export const runNarratorEval = async ({
	narrate,
	judgeKey,
	evalsDir,
	onlyIds = null,
}: RunNarratorEvalParams): Promise<NarratorRow[]> => {
	const judge = new Anthropic({ apiKey: judgeKey, maxRetries: 3 });

	// onlyIds: case ids to run, for iterating on the prompt without paying for the whole suite.
	const allCases = loadCases<Case>(evalsDir, 'cases.json');
	const cases = onlyIds ? allCases.filter((testCase) => onlyIds.has(testCase.id)) : allCases;

	if (onlyIds && cases.length !== onlyIds.size) {
		throw new Error(
			`unknown case ids: ${[...onlyIds].filter((id) => !allCases.some((testCase) => testCase.id === id)).join(', ')}`,
		);
	}

	return mapPool(cases, CONCURRENCY, async (testCase) => {
		const runs: NarratorRun[] = [];
		// Counted per call, so a failed narration and a failed judgment each add one.
		let infraErrors = 0;

		for (let i = 0; i < RUNS; i++) {
			const narrated = await attempt(() =>
				narrate({
					label: testCase.label,
					text: testCase.text,
					asked: testCase.asked,
					focused: testCase.focused,
					topic: null,
				}),
			);

			if (!narrated.ok) {
				infraErrors++;
				continue;
			}

			const narration = narrated.value;
			const judged =
				narration.speak && narration.text
					? await attempt(() =>
							judgeLine(judge, {
								label: testCase.label,
								text: testCase.text,
								needsUser: testCase.expect.needs_user,
								spoken: narration.text,
								asked: testCase.asked,
							}),
						)
					: null;

			if (judged && !judged.ok) {
				infraErrors++;
			}

			const { faithful, reason } = judged?.ok ? judged.value : { faithful: null, reason: '' };

			runs.push({
				needsUser: narration.needs_user === testCase.expect.needs_user,
				speak: narration.speak === testCase.expect.speak,
				format: isFormatOk({
					spoken: narration.text,
					label: testCase.label,
					speak: narration.speak,
					maxWords: testCase.max_words ?? (testCase.focused ? FOCUSED_WORDS : NARRATION_WORDS),
					notIncludes: testCase.not_includes,
				}),
				faithful,
				spoken: narration.text,
				reason,
			});
		}

		const judgedVotes = runs
			.filter((run) => run.faithful !== null)
			.map((run) => run.faithful as boolean);
		const shownRun = runs.find((run) => run.faithful === false) ?? runs[0];

		return {
			id: testCase.id,
			split: testCase.split,
			needsUserOk: isMajority(runs.map((run) => run.needsUser)),
			speakOk: isMajority(runs.map((run) => run.speak)),
			formatOk: runs.every((run) => run.format),
			faithful: judgedVotes.length ? isMajority(judgedVotes) : null,
			spoken: shownRun?.spoken ?? '',
			judgeReason: shownRun?.reason ?? '',
			infraErrors,
		};
	});
};

interface JudgeCalibration {
	accuracy: number;
	misses: string[];
}

export const runJudgeCalibration = async (
	judgeKey: string,
	dir: string,
): Promise<JudgeCalibration> => {
	// Before trusting its scores, the judge must get lines with a known verdict right.
	const judge = new Anthropic({ apiKey: judgeKey, maxRetries: 3 });
	const cases = loadCases<CalibrationCase>(dir, 'judge-calibration.json');
	const results = await mapPool(cases, CONCURRENCY, async (calibrationCase) => {
		const judged = await judgeLine(judge, {
			label: calibrationCase.label,
			text: calibrationCase.text,
			needsUser: calibrationCase.needs_user,
			spoken: calibrationCase.spoken,
			asked: null,
		});

		return { id: calibrationCase.id, ok: judged.faithful === calibrationCase.faithful };
	});

	return {
		accuracy: results.filter((result) => result.ok).length / results.length,
		misses: results.filter((result) => !result.ok).map((result) => result.id),
	};
};

export interface NarratorScore {
	needsUser: number;
	speak: number;
	format: number;
	faithful: number;
	n: number;
	infraErrors: number;
}

export const scoreNarrator = (rows: NarratorRow[]): NarratorScore => {
	const computeRate = (outcomes: boolean[]) =>
		outcomes.length ? outcomes.filter(Boolean).length / outcomes.length : 1;
	const judgedVotes = rows
		.filter((row) => row.faithful !== null)
		.map((row) => row.faithful as boolean);

	return {
		needsUser: computeRate(rows.map((row) => row.needsUserOk)),
		speak: computeRate(rows.map((row) => row.speakOk)),
		format: computeRate(rows.map((row) => row.formatOk)),
		faithful: computeRate(judgedVotes),
		n: rows.length,
		infraErrors: rows.reduce((sum, row) => sum + row.infraErrors, 0),
	};
};
