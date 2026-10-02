import { describe, expect, it } from 'bun:test';
import { configureLog } from '../log.js';
import type { Input, State } from '../shared/protocol.js';
import { Store } from '../state/store.js';
import { worktree } from '../../test/support/reduce.js';
import type { ProgressInput } from '../voice-lines/prompt.js';
import {
	createProgressTurn,
	decideProgress,
	OWN_LINE_QUIET_MS,
	startProgress,
	withoutExtensions,
} from './progress.js';
import type { SpeechMoment, VoiceOut } from './voice-out.js';

configureLog({ quiet: true });

const REF = 'store/main';
const OTHER = 'checkout/main';

const QUIET: SpeechMoment = {
	isTalking: false,
	isMuted: false,
	isBusy: false,
	quietSince: 0,
	hasPage: true,
	isListening: false,
};

const flush = async () => {
	for (let index = 0; index < 10; index++) {
		await Promise.resolve();
	}
};

const createHarness = ({ view = REF }: { view?: string } = {}) => {
	let now = 0;
	const clock = () => now;
	const store = new Store(clock);
	store.dispatch({ type: 'worktrees', worktrees: [worktree(REF), worktree(OTHER)] });
	store.dispatch({ type: 'active_loaded', refs: [REF, OTHER] });
	store.dispatch({ type: 'session_started', ref: REF } as Input);
	store.dispatch({ type: 'session_started', ref: OTHER } as Input);
	store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: view } });
	const timers: { at: number; run: () => void }[] = [];
	const said: Parameters<VoiceOut['say']>[0][] = [];
	const written: ProgressInput[] = [];
	let speech = QUIET;
	let answer: (() => Promise<string>) | null = null;

	startProgress({
		store,
		voiceOut: { say: (line) => said.push(line), readSpeech: () => speech },
		writeProgress: (input) => {
			written.push(input);

			return answer ? answer() : Promise.resolve(`progress ${written.length}`);
		},
		setTimer: (run, ms) => timers.push({ at: now + ms, run }),
		isRouting: () => false,
		now: clock,
	});

	return {
		store,
		said,
		written,
		// Moves the clock, running each timer as it comes due.
		advance: async (ms: number) => {
			const until = now + ms;

			for (;;) {
				timers.sort((first, second) => first.at - second.at);
				const next = timers[0];

				if (!next || next.at > until) {
					break;
				}

				timers.shift();
				now = next.at;
				next.run();
				await flush();
			}

			now = until;
		},
		startTurn: () => store.dispatch({ type: 'send', ref: REF, text: 'refactor the router' }),
		step: (summary: string, name = 'Edit') =>
			store.dispatch({ type: 'tool', ref: REF, name, summary }),
		setSpeech: (patch: Partial<SpeechMoment>) => {
			speech = { ...QUIET, ...patch };
		},
		holdAnswers: (next: () => Promise<string>) => {
			answer = next;
		},
	};
};

const texts = (harness: ReturnType<typeof createHarness>) => harness.said.map((line) => line.text);

describe('progress for the session on screen', () => {
	it('first line at 30 s, then 30 s, 60 s, and every 2 min — each after the step changed', async () => {
		const harness = createHarness();
		let at = 0;

		// Nothing the tick before it is due, one line on the tick it is.
		const expectLineAt = async (due: number) => {
			const before = harness.said.length;
			await harness.advance(due - 5_000 - at);
			expect(harness.said).toHaveLength(before);
			await harness.advance(5_000);
			at = due;
			expect(harness.said).toHaveLength(before + 1);
		};

		harness.startTurn();
		harness.step('edit src/router.ts');
		await expectLineAt(30_000);
		expect(harness.said).toEqual([
			{ text: 'progress 1', priority: 'low', source: 'kernel', ref: REF, isFiller: true },
		]);

		for (const [due, file] of [
			[60_000, 'a'],
			[120_000, 'b'],
			[240_000, 'c'],
			[360_000, 'd'],
		] as const) {
			harness.step(`edit src/${file}.ts`);
			await expectLineAt(due);
		}
	});

	it('nothing changed since the last line → nothing more said', async () => {
		const harness = createHarness();
		harness.startTurn();
		harness.step('edit src/router.ts');
		await harness.advance(10 * 60_000);
		expect(texts(harness)).toEqual(['progress 1']);
	});

	it('no step and no sub-agent yet → nothing; a sub-agent starting is a change', async () => {
		const harness = createHarness();
		harness.startTurn();
		await harness.advance(60_000);
		expect(harness.said).toEqual([]);

		harness.store.dispatch({
			type: 'subagent_started',
			ref: REF,
			taskId: 't1',
			agentType: 'Explore',
			description: 'Find the retry callers',
			isBackground: false,
		});
		await harness.advance(5_000);
		expect(harness.written).toEqual([
			{ step: null, agents: ['Find the retry callers'], lastProgress: null },
		]);
	});

	it('only the spoken form of a step reaches the writer: no raw command, path or pattern', async () => {
		const harness = createHarness();
		harness.startTurn();
		harness.step('run cd /Users/dev/secret && API_KEY=abc bun test --watch', 'Bash');
		await harness.advance(30_000);
		harness.step('search for password=hunter2', 'Grep');
		await harness.advance(30_000);
		harness.step('read /Users/dev/private/notes.md', 'Read');
		await harness.advance(60_000);

		expect(harness.written.map((input) => input.step)).toEqual([
			'run bun test',
			'search the code',
			'read notes',
		]);
		expect(harness.written[1]?.lastProgress).toBe('progress 1');
	});

	it('a session switched to midway → its turn is not timed', async () => {
		const harness = createHarness({ view: OTHER });
		harness.startTurn();
		harness.step('edit src/router.ts');
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: REF } });
		await harness.advance(5 * 60_000);
		expect(harness.said).toEqual([]);
	});

	it('the developer starts talking while it is worded → not said', async () => {
		const harness = createHarness();
		const answer = Promise.withResolvers<string>();
		harness.holdAnswers(() => answer.promise);
		harness.startTurn();
		harness.step('edit src/router.ts');
		await harness.advance(30_000);
		expect(harness.written).toHaveLength(1);

		harness.setSpeech({ isTalking: true });
		answer.resolve('Still on the router.');
		await flush();
		expect(harness.said).toEqual([]);
	});
});

describe('progress across turns', () => {
	const endTurn = (harness: ReturnType<typeof createHarness>) =>
		harness.store.dispatch({ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Done.' });

	it('the turn ends and a new one starts while a line is worded → not said', async () => {
		const harness = createHarness();
		const answer = Promise.withResolvers<string>();
		harness.holdAnswers(() => answer.promise);
		harness.startTurn();
		harness.step('edit src/router.ts');
		await harness.advance(30_000);
		expect(harness.written).toHaveLength(1);

		endTurn(harness);
		harness.startTurn();
		answer.resolve('Still on the router.');
		await flush();
		expect(harness.said).toEqual([]);
	});

	it("a second turn starts fresh: the old turn's step is not its, and the same step again is new to it", async () => {
		const harness = createHarness();
		harness.startTurn();
		harness.step('edit src/router.ts');
		await harness.advance(30_000);
		expect(texts(harness)).toEqual(['progress 1']);

		await harness.advance(10_000);
		endTurn(harness);
		harness.startTurn();
		// Its own 30 s pass with the old turn's step still in the stream: nothing to say about it.
		await harness.advance(30_000);
		expect(texts(harness)).toEqual(['progress 1']);
		harness.step('edit src/router.ts');
		await harness.advance(5_000);
		expect(texts(harness)).toEqual(['progress 1', 'progress 2']);
		expect(harness.written[1]).toEqual({ step: 'edit router', agents: [], lastProgress: null });
	});

	it('the writer fails with two agents at work → "Two agents still working."', async () => {
		const harness = createHarness();
		harness.holdAnswers(() => Promise.reject(new Error('overloaded')));
		harness.startTurn();

		for (const taskId of ['t1', 't2']) {
			harness.store.dispatch({
				type: 'subagent_started',
				ref: REF,
				taskId,
				agentType: 'Explore',
				description: `Search ${taskId}`,
				isBackground: false,
			});
		}

		await harness.advance(30_000);
		expect(texts(harness)).toEqual(['Two agents still working.']);
	});
});

describe('decideProgress: never when', () => {
	const due = () => {
		const harness = createHarness();
		harness.startTurn();
		harness.step('edit src/router.ts');

		return { state: harness.store.state, turn: createProgressTurn(REF, 0), now: 30_000 };
	};

	it('nothing in the way → said', () => {
		const { state, turn, now } = due();

		expect(decideProgress({ turn, state, now, speech: QUIET, isRouting: false })).toEqual({
			kind: 'say',
			step: 'edit router',
			agents: [],
			key: 'edit router|',
		});
	});

	it('a switch offer long lapsed → no block', () => {
		const { state, turn, now } = due();

		expect(
			decideProgress({
				turn,
				state: { ...state, switchOffer: { ref: OTHER, at: now - 10 * 60_000 } },
				now,
				speech: QUIET,
				isRouting: false,
			}).kind,
		).toBe('say');
	});

	it('not yet due → wait', () => {
		const { state, turn } = due();

		expect(decideProgress({ turn, state, now: 29_999, speech: QUIET, isRouting: false })).toEqual({
			kind: 'wait',
		});
	});

	it.each<[string, (state: State, now: number) => State, Partial<SpeechMoment>, boolean, string]>([
		['the developer talks', (state) => state, { isTalking: true }, false, 'talking'],
		['muted', (state) => state, { isMuted: true }, false, 'muted'],
		['routing', (state) => state, {}, true, 'routing'],
		['something plays or waits', (state) => state, { isBusy: true }, false, 'busy'],
		['no page', (state) => state, { hasPage: false }, false, 'no page'],
		[
			'the session spoke for itself lately',
			(state, now) => ({
				...state,
				spoken: [
					{
						id: 'l1',
						text: 'Halfway.',
						source: 'narrator',
						at: now - OWN_LINE_QUIET_MS + 1,
						ref: REF,
					},
				],
			}),
			{},
			false,
			'own line',
		],
		[
			'an ask waits',
			(state) => ({
				...state,
				asks: [
					{
						id: 'a1',
						ref: OTHER,
						at: 1,
						kind: 'permission',
						toolName: 'Bash',
						summary: 'run git push',
						input: {},
						suggestions: [],
					},
				],
			}),
			{},
			false,
			'question open',
		],
		[
			'a fresh switch offer',
			(state, now) => ({ ...state, switchOffer: { ref: OTHER, at: now - 1 } }),
			{},
			false,
			'question open',
		],
		[
			'"For checkout?" waits',
			(state, now) => ({
				...state,
				targetAsk: { ref: OTHER, screen: REF, text: 'run it', at: now - 1 },
			}),
			{},
			false,
			'question open',
		],
		[
			'the meanwhile line would play now',
			(state) => ({ ...state, meanwhile: [{ ref: OTHER, kind: 'done', about: null, at: 0 }] }),
			{},
			false,
			'meanwhile',
		],
		[
			'off screen',
			(state) => ({ ...state, view: { kind: 'session', ref: OTHER } }),
			{},
			false,
			'off screen',
		],
		['inactive', (state) => ({ ...state, active: [] }), {}, false, 'inactive'],
	])('%s → skipped', (_, patch, speech, isRouting, reason) => {
		const { state, turn, now } = due();

		expect(
			decideProgress({
				turn,
				state: patch(state, now),
				now,
				speech: { ...QUIET, ...speech },
				isRouting,
			}),
		).toEqual({ kind: 'skip', reason });
	});

	it('the same step as the last line → skipped', () => {
		const { state, turn, now } = due();

		expect(
			decideProgress({
				turn: { ...turn, lastKey: 'edit router|' },
				state,
				now,
				speech: QUIET,
				isRouting: false,
			}),
		).toEqual({ kind: 'skip', reason: 'nothing changed' });
	});
});

describe('withoutExtensions', () => {
	it('a file name loses its extension; a version or a decimal keeps its point', () => {
		expect(withoutExtensions('edit retry.ts')).toBe('edit retry');
		expect(withoutExtensions('read Dockerfile.dev')).toBe('read Dockerfile');
		expect(withoutExtensions('edit router.spec.ts')).toBe('edit router');
		expect(withoutExtensions('read app.config.json')).toBe('read app');
		expect(withoutExtensions('bump to 2.0')).toBe('bump to 2.0');
		expect(withoutExtensions('set pi to 3.14')).toBe('set pi to 3.14');
	});
});
