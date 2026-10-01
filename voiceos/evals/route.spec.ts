import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureState, type FixtureContext } from '../test/support/state.js';
import type Anthropic from '@anthropic-ai/sdk';
import {
	costOf,
	countUsage,
	decideFromKernel,
	emptyUsage,
	findCaseProblems,
	loadRouteCases,
	parseRouteSystems,
	type RouteCase,
	type RouteRow,
	scoreRoute,
} from './route.js';
import { parseRouteAnswer } from './route/classifier.js';

const SCREEN = 'store-front/main';
const call = (name: string, input: Record<string, unknown> = {}, ok = true) => ({
	name,
	input,
	ok,
});

describe('decideFromKernel', () => {
	it.each([
		['a forward', [call('forward')], 'session'],
		['send_to the screen', [call('send_to', { ref: SCREEN })], 'session'],
		['send_to the screen that failed', [call('send_to', { ref: SCREEN }, false)], 'voiceos'],
		['send_to another session', [call('send_to', { ref: 'checkout-api/main' })], 'voiceos'],
		[
			'a forward and a send_to another session',
			[call('forward'), call('send_to', { ref: 'checkout-api/main' })],
			'voiceos',
		],
		['a switch', [call('switch_view', { ref: 'checkout-api/main' })], 'voiceos'],
		['a forward and a switch', [call('forward'), call('switch_view', { ref: 'x' })], 'voiceos'],
		['only a read (the kernel answered itself)', [call('read_state')], 'voiceos'],
		['only a list', [call('list_sessions')], 'voiceos'],
		['nothing at all', [], 'voiceos'],
		['words ignored', [call('ignore_words')], 'voiceos'],
		['a forward that failed', [call('forward', {}, false)], 'voiceos'],
		['a forward beside a read', [call('read_state'), call('forward')], 'session'],
	] as const)('%s → %s', (_, calls, want) => {
		expect(decideFromKernel([...calls], SCREEN)).toBe(want);
	});
});

describe('scoreRoute', () => {
	const row = (label: RouteRow['label'], decision: RouteRow['decision'], ms = 100): RouteRow => ({
		id: `${label}-${decision}`,
		label,
		source: 'pairs',
		decision,
		ms,
		calls: [],
	});

	it('the two mistakes apart, unclear counted wrong and reported, API failures left out', () => {
		expect(
			scoreRoute([
				row('session', 'session', 100),
				row('voiceos', 'voiceos', 200),
				row('voiceos', 'session', 300),
				row('session', 'voiceos', 400),
				row('session', 'unclear', 500),
				row('voiceos', null, 0),
			]),
		).toEqual({
			n: 5,
			accuracy: 0.4,
			leaked: 1,
			swallowed: 1,
			unclear: 1,
			infraErrors: 1,
			medianMs: 300,
			p90Ms: 500,
		});
	});
});

describe('parseRouteAnswer', () => {
	it.each([
		['session', 'session'],
		['Session.', 'session'],
		['**voiceos**', 'voiceos'],
		['Voice OS', 'voiceos'],
		['unclear', 'unclear'],
		['', 'unclear'],
		['I think the session', 'unclear'],
	] as const)('%j → %s', (text, want) => {
		expect(parseRouteAnswer(text)).toBe(want);
	});
});

describe('parseRouteSystems', () => {
	it('both by default, one when named, anything else refused before a paid call', () => {
		expect(parseRouteSystems(undefined)).toEqual(['kernel', 'classifier']);
		expect(parseRouteSystems('both')).toEqual(['kernel', 'classifier']);
		expect(parseRouteSystems('kernel')).toEqual(['kernel']);
		expect(parseRouteSystems('classifier')).toEqual(['classifier']);
		expect(() => parseRouteSystems('router')).toThrow('--system must be');
	});
});

describe('the usage line', () => {
	it('prices a million of each at Haiku rates', () => {
		expect(
			costOf({ input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6, calls: 1 }),
		).toBeCloseTo(7.35);
	});

	it('every message call adds what the API reported, cache fields absent counted as none', async () => {
		const responses = [
			{
				usage: {
					input_tokens: 10,
					output_tokens: 2,
					cache_read_input_tokens: 100,
					cache_creation_input_tokens: 50,
				},
			},
			{ usage: { input_tokens: 5, output_tokens: 1 } },
		];
		const client = {
			messages: { create: async () => responses.shift() },
		} as unknown as Anthropic;
		const usage = emptyUsage();

		countUsage(client, usage);
		await client.messages.create({} as never);
		await client.messages.create({} as never);

		expect(usage).toEqual({ input: 15, cacheRead: 100, cacheWrite: 50, output: 3, calls: 2 });
	});
});

describe('a heard line said by Voice OS', () => {
	it("is Voice OS's own, asking only when it ends in a question; a plain line stays the session's", () => {
		const state = createFixtureState({
			view: 'store-front/main',
			heard: [
				{ text: 'Switch to checkout?', ref: 'checkout-api/main', secondsAgo: 9, byVoiceOs: true },
				{ text: 'Sent to checkout.', ref: 'checkout-api/main', secondsAgo: 6, byVoiceOs: true },
				{ text: 'Tests pass.', ref: 'store-front/main', secondsAgo: 3 },
			],
		});

		expect(
			state.spoken.map((line) => ({ source: line.source, isAsking: line.isAsking ?? false })),
		).toEqual([
			{ source: 'kernel', isAsking: true },
			{ source: 'kernel', isAsking: false },
			{ source: 'narrator', isAsking: false },
		]);
	});
});

describe('findCaseProblems', () => {
	const testCase = (context: FixtureContext): RouteCase => ({
		id: 'c',
		utterance: 'run the tests',
		context,
		label: 'session',
		source: 'speech',
	});

	it('a case with no screen is one problem', () => {
		expect(findCaseProblems([testCase({})])).toEqual(['c: not on a session screen']);
	});

	it('a ref its fixture lacks is one problem', () => {
		expect(
			findCaseProblems([
				testCase({
					view: 'store-front/main',
					heard: [{ text: 'done', ref: 'infra-ops/main', secondsAgo: 5 }],
				}),
			]),
		).toEqual(['c: names infra-ops/main, not a session of its fixture']);
	});

	it('a ref given in extraRefs is fine', () => {
		expect(
			findCaseProblems([
				testCase({
					view: 'store-front/main',
					extraRefs: ['infra-ops/main'],
					heard: [{ text: 'done', ref: 'infra-ops/main', secondsAgo: 5 }],
				}),
			]),
		).toEqual([]);
	});

	it('a label no decision equals is one problem', () => {
		expect(
			findCaseProblems([
				{ ...testCase({ view: 'store-front/main' }), label: 'voice os' as RouteCase['label'] },
			]),
		).toEqual(['c: label voice os is not session or voiceos']);
	});

	it('an id used twice (a speech case reusing a repo id) is one problem', () => {
		const once = testCase({ view: 'store-front/main' });

		expect(findCaseProblems([once, once, once])).toEqual(['c: id used twice']);
	});
});

describe('the route cases', () => {
	// Only the cases in the repo: the developer's own speech file is not read by the free tests.
	const cases = loadRouteCases(import.meta.dir, null);
	const kernelCases = new Map(
		(
			JSON.parse(readFileSync(join(import.meta.dir, 'kernel', 'cases.json'), 'utf8')) as {
				cases: {
					id: string;
					utterance: string;
					context: FixtureContext;
					calls: never[];
					allow?: never[];
				}[];
			}
		).cases.map((testCase) => [testCase.id, testCase]),
	);

	it('ids are unique, labels and sources known, and no case repeats another word for word', () => {
		expect(new Set(cases.map((testCase) => testCase.id)).size).toBe(cases.length);
		expect(
			new Set(cases.map((testCase) => `${testCase.utterance}|${JSON.stringify(testCase.context)}`))
				.size,
		).toBe(cases.length);

		for (const testCase of cases) {
			expect(['session', 'voiceos']).toContain(testCase.label);
			expect(['kernel', 'pairs']).toContain(testCase.source);
		}
	});

	it('every case is on a session screen, and every ref it names is a session of its fixture', () => {
		expect(findCaseProblems(cases)).toEqual([]);
	});

	it('a meanwhile line is an update, never the screen session speaking', () => {
		for (const testCase of cases) {
			for (const line of testCase.context.heard ?? []) {
				if (/^\s*meanwhile/i.test(line.text)) {
					expect({ id: testCase.id, update: line.update }).toEqual({
						id: testCase.id,
						update: true,
					});
				}
			}
		}
	});

	it('a case taken from the kernel suite still matches it, and its label still follows its calls', () => {
		for (const testCase of cases.filter((candidate) => candidate.source === 'kernel')) {
			const source = kernelCases.get(testCase.id.replace(/^k-/, ''));
			const view = testCase.context.view ?? '';

			type Expected = { name: string; ref?: string; input?: { ref?: string } };

			const calls = (source?.calls ?? []) as Expected[];
			const allowed = ((source as { allow?: Expected[] } | undefined)?.allow ?? []) as Expected[];

			expect(source?.utterance).toBe(testCase.utterance);
			expect(source?.context).toEqual(testCase.context);
			// Expected calls name their session as ref (or in input): the shape decideFromKernel reads.
			const asCall = (expected: Expected) => ({
				name: expected.name,
				input: { ref: expected.ref ?? expected.input?.ref },
				ok: true,
			});
			const recorded = calls.map(asCall);
			// A call the kernel suite allows passes there, so it must not change the route label either.
			const decisions = [
				decideFromKernel(recorded, view),
				...allowed.map((extra) => decideFromKernel([...recorded, asCall(extra)], view)),
			];

			expect({ id: testCase.id, labels: decisions }).toEqual({
				id: testCase.id,
				labels: decisions.map(() => testCase.label),
			});
		}
	});
});
