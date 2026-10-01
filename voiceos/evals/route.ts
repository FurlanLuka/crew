// The route eval: on a session's screen, are the words for that session or a command for Voice OS?
// Today's kernel and a narrow classifier answer the same cases; the scores say whether a router split
// in two would route better. A measurement, never a gate. Every run bills the Anthropic key.
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createJudge } from '../src/judge/judge.js';
import { buildKernelMessage, type KernelResult, recallVoiceEntries } from '../src/router/kernel.js';
import { readScreenRef } from '../src/state/helpers.js';
import { createFixtureState, type FixtureContext } from '../test/support/state.js';
import { runEvalTurn } from './kernel.js';
import { attempt, mapPool } from './pool.js';
import { classifyRoute, type RouteDecision } from './route/classifier.js';

export type RouteLabel = 'session' | 'voiceos';

export interface RouteCase {
	id: string;
	utterance: string;
	context: FixtureContext;
	label: RouteLabel;
	source: 'kernel' | 'speech' | 'pairs';
}

export type RouteSystem = 'kernel' | 'classifier';

export interface RouteRow {
	id: string;
	label: RouteLabel;
	source: RouteCase['source'];
	decision: RouteDecision | null;
	ms: number;
	// What the kernel did, for reading a miss; empty for the classifier.
	calls: string[];
}

type Call = KernelResult['calls'][number];

// Reads change nothing, so they decide nothing.
const READS = new Set(['read_state', 'read_history', 'read_notes', 'list_sessions']);

// The kernel's turn read as the one decision: every call that changed something reached the session
// on screen → session (a spoken reply beside it changes nothing). Anything else — another call, a
// reply with no send, words ignored → voiceos: doing nothing counts as keeping the words, which is
// what a router would see. The ref is the one the model named; a send_to kept on the screen as a
// continuation still records its named ref, so that rare case scores voiceos.
export const decideFromKernel = (calls: Call[], screen: string): RouteDecision => {
	const isToScreen = (call: Call): boolean =>
		call.name === 'forward' || (call.name === 'send_to' && call.input.ref === screen);
	const effective = calls.filter((call) => call.ok && !READS.has(call.name));

	return effective.length > 0 && effective.every(isToScreen) ? 'session' : 'voiceos';
};

export interface RouteScore {
	n: number;
	accuracy: number;
	// A command for Voice OS that went to the session.
	leaked: number;
	// Words for the session that Voice OS took.
	swallowed: number;
	unclear: number;
	infraErrors: number;
	medianMs: number;
	p90Ms: number;
}

const percentile = (values: number[], p: number): number => {
	const sorted = [...values].sort((left, right) => left - right);

	return sorted.length === 0
		? 0
		: (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
};

// Unclear counts as wrong in accuracy: it is reported apart too, since a router would hand it on.
export const scoreRoute = (rows: RouteRow[]): RouteScore => {
	const decided = rows.filter((row) => row.decision !== null);
	const ms = decided.map((row) => row.ms);

	return {
		n: decided.length,
		accuracy:
			decided.filter((row) => row.decision === row.label).length / Math.max(1, decided.length),
		leaked: decided.filter((row) => row.label === 'voiceos' && row.decision === 'session').length,
		swallowed: decided.filter((row) => row.label === 'session' && row.decision === 'voiceos')
			.length,
		unclear: decided.filter((row) => row.decision === 'unclear').length,
		infraErrors: rows.length - decided.length,
		medianMs: percentile(ms, 0.5),
		p90Ms: percentile(ms, 0.9),
	};
};

// --system: which of the two to run; checked before any paid call.
export const parseRouteSystems = (arg: string | undefined): RouteSystem[] => {
	switch (arg ?? 'both') {
		case 'both':
			return ['kernel', 'classifier'];
		case 'kernel':
			return ['kernel'];
		case 'classifier':
			return ['classifier'];
		default:
			throw new Error(`--system must be kernel, classifier or both, not ${arg}`);
	}
};

// Tokens a run used, as the API reported them: what it cost, not an estimate.
export interface RouteUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	calls: number;
}

export const emptyUsage = (): RouteUsage => ({
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0,
	calls: 0,
});

// Haiku 4.5, dollars per million tokens: route runs refuse another kernel model.
const PRICE = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 };

export const costOf = (usage: RouteUsage): number =>
	(usage.input * PRICE.input +
		usage.cacheRead * PRICE.cacheRead +
		usage.cacheWrite * PRICE.cacheWrite +
		usage.output * PRICE.output) /
	1_000_000;

// Wraps the client's message calls so each adds its usage to the tally (none of them stream).
export const countUsage = (client: Anthropic, usage: RouteUsage): Anthropic => {
	const create = client.messages.create.bind(client.messages);

	client.messages.create = (async (...args: Parameters<typeof create>) => {
		const response = (await create(...args)) as Anthropic.Message;

		usage.calls += 1;
		usage.input += response.usage.input_tokens;
		usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
		usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
		usage.output += response.usage.output_tokens;

		return response;
	}) as typeof client.messages.create;

	return client;
};

// The developer's own speech cases hold real work: they stay on this machine, never in the repo.
export const localSpeechFile = (): string =>
	process.env.VOICEOS_ROUTE_SPEECH ??
	join(homedir(), '.crew', 'voiceos', 'evals', 'route-speech.json');

const readCases = (file: string): RouteCase[] =>
	(JSON.parse(readFileSync(file, 'utf8')) as { cases: RouteCase[] }).cases;

// speechFile null: the repo's cases alone (the free specs never read the developer's file).
export const loadRouteCases = (evalsDir: string, speechFile: string | null): RouteCase[] => [
	...readCases(join(evalsDir, 'route', 'cases.json')),
	...(speechFile && existsSync(speechFile) ? readCases(speechFile) : []),
];

// Every ref a fixture names: createFixtureState drops one it does not have, silently.
export const namedRefs = (context: FixtureContext): string[] => [
	...(context.heard ?? []).map((line) => line.ref),
	...(context.switchOffer ? [context.switchOffer.ref] : []),
	...Object.keys(context.names ?? {}),
	...(context.inactive ?? []),
	...(context.stopped ?? []),
	...(context.work ?? []).map((work) => work.ref),
	...(context.meanwhile ?? []).map((item) => item.ref),
	...(context.needs ? [context.needs] : []),
	...(context.askOn ? [context.askOn] : []),
	...(context.alsoAsk ? [context.alsoAsk] : []),
	...(context.dev ? [context.dev] : []),
	...(context.denied ? [context.denied] : []),
	...(context.offer ? [context.offer.ref] : []),
	...(context.alert?.ref ? [context.alert.ref] : []),
	...(context.announced ? [context.announced.ref] : []),
	...(context.update ? [context.update.ref] : []),
	...(context.docs ?? []).map((doc) => doc.ref),
];

// A case scored on the wrong setup, or under a label no decision equals, reports nothing: the speech
// file, built by hand from logs, is checked here before a paid call, the repo's cases by the spec.
const findSetupProblems = (testCase: RouteCase): string[] => {
	const state = createFixtureState(testCase.context);
	const view = testCase.context.view;

	return [
		...(view && state.view.kind === 'session' ? [] : [`${testCase.id}: not on a session screen`]),
		...(testCase.label === 'session' || testCase.label === 'voiceos'
			? []
			: [`${testCase.id}: label ${String(testCase.label)} is not session or voiceos`]),
		...[...(view ? [view] : []), ...namedRefs(testCase.context)]
			.filter((ref) => !state.sessions[ref])
			.map((ref) => `${testCase.id}: names ${ref}, not a session of its fixture`),
	];
};

export const findCaseProblems = (cases: RouteCase[]): string[] => {
	const seen = new Set<string>();
	const repeated = new Set(
		cases.flatMap((testCase) => {
			const isRepeat = seen.has(testCase.id);

			seen.add(testCase.id);

			return isRepeat ? [testCase.id] : [];
		}),
	);

	return [
		...cases.flatMap(findSetupProblems),
		...[...repeated].map((id) => `${id}: id used twice`),
	];
};

const CONCURRENCY = 4;

interface RunRouteEvalParams {
	apiKey: string;
	evalsDir: string;
	system: RouteSystem;
	usage: RouteUsage;
	onlyIds?: Set<string> | null;
}

export const runRouteEval = async ({
	apiKey,
	evalsDir,
	system,
	usage,
	onlyIds = null,
}: RunRouteEvalParams): Promise<RouteRow[]> => {
	const all = loadRouteCases(evalsDir, localSpeechFile());
	const problems = findCaseProblems(all);

	if (problems.length > 0) {
		throw new Error(`route cases on the wrong setup:\n${problems.join('\n')}`);
	}

	const cases = onlyIds ? all.filter((testCase) => onlyIds.has(testCase.id)) : all;

	if (onlyIds && cases.length !== onlyIds.size) {
		const known = new Set(all.map((testCase) => testCase.id));

		throw new Error(`unknown case ids: ${[...onlyIds].filter((id) => !known.has(id)).join(', ')}`);
	}

	const client = countUsage(new Anthropic({ apiKey, maxRetries: 2, timeout: 30_000 }), usage);
	const judge = system === 'kernel' ? createJudge({ apiKey, client }) : null;

	return mapPool(cases, CONCURRENCY, async (testCase): Promise<RouteRow> => {
		const base = {
			id: testCase.id,
			label: testCase.label,
			source: testCase.source,
			calls: [] as string[],
		};
		const startedAt = Date.now();

		if (!judge) {
			const state = createFixtureState(testCase.context);
			const context = buildKernelMessage({
				state,
				utterance: testCase.utterance,
				memory: recallVoiceEntries(state, readScreenRef(state), startedAt),
				now: startedAt,
			});
			const result = await attempt(() => classifyRoute({ client, context }));

			return { ...base, decision: result.ok ? result.value : null, ms: Date.now() - startedAt };
		}

		const result = await attempt(() =>
			runEvalTurn({
				apiKey,
				client,
				judge,
				context: testCase.context,
				utterance: testCase.utterance,
			}),
		);

		return result.ok
			? {
					...base,
					decision: decideFromKernel(result.value.calls, testCase.context.view ?? ''),
					ms: Date.now() - startedAt,
					calls: result.value.calls.map((call) => `${call.name}${call.ok ? '' : ' (failed)'}`),
				}
			: { ...base, decision: null, ms: Date.now() - startedAt };
	});
};
