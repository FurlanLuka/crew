import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Kernel, type KernelResult } from '../src/router/kernel.js';
import { readActiveRef } from '../src/router/refs.js';
import { createNullNotes } from '../test/support/notes.js';
import { reduce } from '../src/state/reducer.js';
import { MUTATING_TOOLS, type ToolName } from '../src/tools/definitions.js';
import { createFixtureState, type FixtureContext } from '../test/support/state.js';
import { attempt, mapPool } from './pool.js';

interface ExpectedCall {
	name: ToolName;
	ref?: string | null;
	action?: string;
	// Arguments that must match exactly (an answer's decision, a fix offer's accept).
	input?: Record<string, unknown>;
	// The kernel rewrites what it forwards, so every entry must survive; "not|don't" accepts either.
	text_includes?: string | string[];
	// Relay words that must not be passed on ("ask it", "tell it").
	not_includes?: string[];
	// Arguments the call must not have with these values (a continuation flag on a new request).
	not_input?: Record<string, unknown>;
}

interface Case {
	id: string;
	utterance: string;
	context: FixtureContext;
	calls: ExpectedCall[];
	// Calls that are fine but not required (starting a session before opening it is harmless).
	allow?: ExpectedCall[];
	forbid_mutation?: boolean;
	// A question, which must get a spoken reply: silence reads as broken.
	answer?: boolean;
	// Words that ask for nothing (a fragment, "hey"): no change and no reply, on every run.
	silent?: boolean;
	// The expected calls happen and nothing is said ("quiet").
	no_reply?: boolean;
	// The developer asked for detail or a list; otherwise replies stay short.
	long_reply?: boolean;
	// A cap for a long reply: a read-back is a few sentences, never the whole message.
	max_words?: number;
	// Words the spoken reply must contain ("a|b" accepts either).
	reply_includes?: string[];
	// Words it must not contain: an invented detail.
	reply_not_includes?: string[];
}

// A spoken reply longer than this is a lecture, not an answer.
export const REPLY_WORDS = 25;

// The kernel runs at temperature 0, so repeats mostly agree: one run each keeps a full run cheap.
// A case that must never act by voice is still run three times, and must hold every time.
const RUNS = 1;
const MUST_HOLD_RUNS = 3;
const CONCURRENCY = 4;

const isMustHold = (testCase: Case): boolean =>
	Boolean(testCase.forbid_mutation || testCase.silent);

export const countRuns = (testCase: Case): number => (isMustHold(testCase) ? MUST_HOLD_RUNS : RUNS);

type Call = KernelResult['calls'][number];

interface Verdict {
	ok: boolean;
	why: string;
}

interface KernelRun extends Verdict {
	calls: KernelResult['calls'];
	reply: string;
}

export interface KernelRow {
	id: string;
	passes: number;
	needed: number;
	runs: KernelRun[];
	mutating: boolean;
	infraErrors: number;
}

const isMutation = (call: Call): boolean => {
	if (!MUTATING_TOOLS.includes(call.name as ToolName)) {
		return false;
	}

	return !(call.name === 'crew_dev' && call.input.action === 'status');
};

const asList = (value: string | string[] | undefined): string[] =>
	value === undefined ? [] : Array.isArray(value) ? value : [value];

interface TextProblems {
	missing: string[];
	relayed: string[];
}

export const findTextProblems = (text: string, expected: ExpectedCall): TextProblems => {
	const sent = text.toLowerCase();
	const missing = asList(expected.text_includes).filter(
		(entry) => !entry.split('|').some((alternative) => sent.includes(alternative.toLowerCase())),
	);
	const relayed = (expected.not_includes ?? []).filter((phrase) =>
		sent.includes(phrase.toLowerCase()),
	);

	return { missing, relayed };
};

const matchesCall = (call: Call, expected: ExpectedCall): boolean => {
	if (call.name !== expected.name) {
		return false;
	}

	if (expected.ref !== undefined && (call.input.ref ?? null) !== expected.ref) {
		return false;
	}

	if (expected.action && call.input.action !== expected.action) {
		return false;
	}

	if (Object.entries(expected.input ?? {}).some(([key, value]) => call.input[key] !== value)) {
		return false;
	}

	if (Object.entries(expected.not_input ?? {}).some(([key, value]) => call.input[key] === value)) {
		return false;
	}

	const { missing, relayed } = findTextProblems(String(call.input.text ?? ''), expected);

	return missing.length === 0 && relayed.length === 0;
};

const describeMiss = (expected: ExpectedCall, sent: unknown): string => {
	const expectedLabel = `${expected.name}(${[expected.ref ?? '', expected.action ?? '', expected.input ? JSON.stringify(expected.input) : ''].filter(Boolean).join(' ')})`;

	if (typeof sent !== 'string') {
		return `missing ${expectedLabel}`;
	}

	const { missing, relayed } = findTextProblems(sent, expected);
	const problems = [
		...(missing.length ? [`without ${missing.join(', ')}`] : []),
		...(relayed.length ? [`still saying ${relayed.join(', ')}`] : []),
	];

	return `missing ${expectedLabel} — sent "${sent}"${problems.length ? ` (${problems.join('; ')})` : ''}`;
};

export interface JudgeRunParams {
	calls: Call[];
	reply: string;
	testCase: Case;
}

export const judgeRun = ({ calls: made, reply, testCase }: JudgeRunParams): Verdict => {
	// send_to the session on screen does what forward does: the same words reach the same session.
	const calls = made.map((call) =>
		call.name === 'send_to' && call.input.ref === testCase.context.view
			? { ...call, name: 'forward' }
			: call,
	);

	for (const expected of testCase.calls) {
		if (!calls.some((call) => matchesCall(call, expected))) {
			return {
				ok: false,
				why: describeMiss(expected, calls.find((call) => call.name === expected.name)?.input.text),
			};
		}
	}

	// An unexpected mutation is the failure that matters most in a voice interface.
	const tolerated = [...testCase.calls, ...(testCase.allow ?? [])];
	const stray = calls.filter(
		(call) =>
			isMutation(call) && call.ok && !tolerated.some((expected) => matchesCall(call, expected)),
	);

	if (stray.length > 0) {
		return {
			ok: false,
			why: `unexpected ${stray.map((call) => `${call.name}(${JSON.stringify(call.input)})`).join(', ')}`,
		};
	}

	// An answer that fell back to sending is recorded as a forward: two of them to one session
	// match the expected call and still sent the words twice.
	const sentTo = calls
		.filter((call) => call.ok && (call.name === 'forward' || call.name === 'send_to'))
		.map((call) =>
			call.name === 'forward' ? (testCase.context.view ?? 'the screen') : String(call.input.ref),
		);
	const twice = sentTo.find((ref, index) => sentTo.indexOf(ref) !== index);

	if (twice) {
		return { ok: false, why: `sent twice to ${twice}` };
	}

	if (
		(testCase.forbid_mutation || testCase.silent) &&
		calls.some((call) => call.ok && isMutation(call))
	) {
		return { ok: false, why: 'mutated in a case that must not' };
	}

	if (testCase.answer && !reply.trim()) {
		return { ok: false, why: 'a question got no spoken answer' };
	}

	if (testCase.silent && reply.trim()) {
		return { ok: false, why: `replied to words that ask for nothing: "${reply}"` };
	}

	if (testCase.no_reply && reply.trim()) {
		return { ok: false, why: `spoke when asked for quiet: "${reply}"` };
	}

	const unsaid = (testCase.reply_includes ?? []).filter(
		(entry) =>
			!entry
				.split('|')
				.some((alternative) => reply.toLowerCase().includes(alternative.toLowerCase())),
	);

	if (unsaid.length > 0) {
		return { ok: false, why: `the reply leaves out ${unsaid.join(', ')}: "${reply}"` };
	}

	const invented = (testCase.reply_not_includes ?? []).filter((word) =>
		reply.toLowerCase().includes(word.toLowerCase()),
	);

	if (invented.length > 0) {
		return { ok: false, why: `the reply says ${invented.join(', ')}: "${reply}"` };
	}

	const replyWordCount = reply.split(/\s+/).filter(Boolean).length;

	const maxWords = testCase.long_reply ? (testCase.max_words ?? Infinity) : REPLY_WORDS;

	if (replyWordCount > maxWords) {
		return { ok: false, why: `a ${replyWordCount}-word reply: "${reply}"` };
	}

	return { ok: true, why: '' };
};

export const isMutatingCase = (testCase: Case): boolean => {
	return (
		Boolean(testCase.forbid_mutation || testCase.silent) ||
		testCase.calls.some((call) =>
			isMutation({ name: call.name, input: { action: call.action }, ok: true }),
		)
	);
};

interface KernelEvalResult {
	rows: KernelRow[];
	score: Record<string, number>;
}

interface RunKernelEvalParams {
	apiKey: string;
	evalsDir: string;
	onlyIds?: Set<string> | null;
	// Another kernel model to compare against the one it runs on.
	model?: string;
}

export const runKernelEval = async ({
	apiKey,
	evalsDir,
	onlyIds = null,
	model,
}: RunKernelEvalParams): Promise<KernelEvalResult> => {
	// onlyIds: case ids to run, for iterating on a prompt without paying for the whole suite.
	const allCases = (
		JSON.parse(readFileSync(join(evalsDir, 'kernel', 'cases.json'), 'utf8')) as { cases: Case[] }
	).cases;
	const cases = onlyIds ? allCases.filter((testCase) => onlyIds.has(testCase.id)) : allCases;

	if (onlyIds && cases.length !== onlyIds.size) {
		throw new Error(
			`unknown case ids: ${[...onlyIds].filter((id) => !allCases.some((testCase) => testCase.id === id)).join(', ')}`,
		);
	}

	const rows = await mapPool(cases, CONCURRENCY, async (testCase): Promise<KernelRow> => {
		const runs: KernelRun[] = [];

		for (let i = 0; i < countRuns(testCase); i++) {
			// Actions change the state as they would live (an answered ask closes); effects go nowhere.
			let state = createFixtureState(testCase.context);
			const screen = readActiveRef(state);

			const dispatch = (input: Parameters<typeof reduce>[1]['input']) => {
				state = reduce(state, {
					seq: state.seq + 1,
					at: Date.now(),
					id: `e${state.seq + 1}`,
					input,
				}).state;
			};

			const kernel = new Kernel({
				apiKey,
				...(model ? { model } : {}),
				tools: {
					getState: () => state,
					dispatch,
					mute: () => {
						// Effects go nowhere in an eval.
					},
					// Two notes on file: "go through my notes" means something only when there are some.
					notes: {
						...createNullNotes(),
						read: () => [
							'- 2026-09-27 07:05 — try a tone per session',
							'- 2026-09-27 07:09 — cache the worktree list',
						],
						has: () => true,
					},
					saveDebugNote: () => {
						// Effects go nowhere in an eval.
					},
					readHistory: ({ ref }) => [
						{
							ts: '2026-09-24T16:02:00Z',
							ref: ref ?? 'checkout-api/main',
							asked: 'add retry backoff',
							did: 'Added exponential backoff to webhook retries; tests pass.',
						},
					],
				},
			});
			const result = await attempt(() =>
				kernel.handle(testCase.utterance, {
					forwardTo: screen,
					screen,
					isSpoken: true,
					setHandsFree: () => 'changed',
				}),
			);

			if (!result.ok) {
				continue;
			}

			runs.push({
				calls: result.value.calls,
				reply: result.value.reply,
				...judgeRun({ calls: result.value.calls, reply: result.value.reply, testCase }),
			});
		}

		// One stray mutation in three is still a real action taken by voice: every run must pass.
		const needed = runs.length;

		return {
			id: testCase.id,
			passes: runs.filter((run) => run.ok).length,
			needed,
			runs,
			mutating: isMutatingCase(testCase),
			// Every run that did not complete failed at the API.
			infraErrors: countRuns(testCase) - runs.length,
		};
	});

	const hasPassed = (row: KernelRow) => row.runs.length > 0 && row.passes >= row.needed;
	const mutatingRows = rows.filter((row) => row.mutating);

	for (const row of rows.filter((candidate) => !hasPassed(candidate))) {
		console.log(
			`  ✗ ${row.id}: ${row.passes}/${row.runs.length} (needs ${row.needed}) — ${row.runs.find((run) => !run.ok)?.why ?? 'no completed run'} · reply: "${row.runs[0]?.reply}"`,
		);
	}

	return {
		rows,
		score: {
			overall: rows.filter(hasPassed).length / rows.length,
			mutating: mutatingRows.length
				? mutatingRows.filter(hasPassed).length / mutatingRows.length
				: 1,
			infraErrors:
				rows.reduce((sum, row) => sum + row.infraErrors, 0) /
				cases.reduce((sum, testCase) => sum + countRuns(testCase), 0),
		},
	};
};
