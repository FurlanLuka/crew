// Drives real Claude Code sessions through the Agent SDK: costs money, so gated behind VOICEOS_LIVE=1.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../../src/log.js';
import { loadTranscript, restoreHistory } from '../../src/sessions/history.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { loadRegistry } from '../../src/sessions/registry.js';
import type { Session, State } from '../../src/shared/protocol.js';
import { Store } from '../../src/state/store.js';

const isLive = process.env.VOICEOS_LIVE === '1';
// Locally workers bill the subscription; the nightly CI job sets apikey so they keep ANTHROPIC_API_KEY.
const isApiKeyAuth = process.env.VOICEOS_WORKER_AUTH === 'apikey';
const REF = 'store-front/main';
const TIMEOUT_MS = 120_000;

interface WaitForStateParams {
	store: Store;
	predicate: (state: State) => boolean;
	label: string;
	timeoutMs?: number;
}

const waitForState = ({
	store,
	predicate,
	label,
	timeoutMs = 90_000,
}: WaitForStateParams): Promise<State> => {
	return new Promise((resolve, reject) => {
		if (predicate(store.state)) {
			resolve(store.state);

			return;
		}

		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(`timed out waiting for ${label}`));
		}, timeoutMs);
		const unsubscribe = store.subscribe((_, state) => {
			if (!predicate(state)) {
				return;
			}

			clearTimeout(timer);
			unsubscribe();
			resolve(state);
		});
	});
};

const readSession = (state: State): Session => state.sessions[REF] as Session;
const isIdle = (state: State) => readSession(state).status === 'idle';
const findLastText = (state: State) =>
	[...readSession(state).stream].reverse().find((item) => item.kind === 'text');

describe.skipIf(!isLive)('live session core', () => {
	const dir = mkdtempSync(join(tmpdir(), 'voiceos-live-'));
	const registryFile = join(dir, 'sessions.json');
	let store: Store;
	let manager: SessionManager;

	const bootManager = (permissionMode: 'auto' | 'default') => {
		store = new Store();
		manager = new SessionManager({
			store,
			registryFile,
			home: process.env.HOME ?? dir,
			fetchOrientation: async () =>
				'You are running inside an automated test. Keep every reply to one short line.',
			shouldKeepApiKey: isApiKeyAuth,
			model: 'claude-haiku-4-5',
			maxBudgetUsd: 0.5,
			permissionMode,
		});
		store.onEffect(manager.handle);
		store.dispatch({
			type: 'worktrees',
			worktrees: [{ ref: REF, label: REF, branch: 'main', cwd: dir, dirs: [], isPinned: false }],
		});
	};

	beforeAll(() => configureLog({ quiet: true }));
	afterAll(() => manager?.stopAll());

	it(
		'permission → ask appears, allow runs the command, session id recorded',
		async () => {
			bootManager('default');
			store.dispatch({
				type: 'send',
				ref: REF,
				text: 'Run exactly this bash command and nothing else: touch probe.txt',
			});

			const asked = await waitForState({
				store,
				predicate: (state) => state.asks.some((ask) => ask.kind === 'permission'),
				label: 'permission ask',
			});
			const ask = asked.asks[0];
			expect(ask).toMatchObject({ kind: 'permission', toolName: 'Bash' });
			store.dispatch({ type: 'answer_permission', askId: ask?.id ?? '', decision: 'allow' });

			await waitForState({ store, predicate: isIdle, label: 'turn end' });
			expect(existsSync(join(dir, 'probe.txt'))).toBe(true);
			expect(loadRegistry(registryFile)[REF]?.sessionId).toBeString();
		},
		TIMEOUT_MS,
	);

	it(
		'deny with a reason → Claude sees the reason',
		async () => {
			store.dispatch({
				type: 'send',
				ref: REF,
				text: 'Run exactly this bash command: touch denied.txt',
			});
			const asked = await waitForState({
				store,
				predicate: (state) => state.asks.length > 0,
				label: 'permission ask',
			});
			store.dispatch({
				type: 'answer_permission',
				askId: asked.asks[0]?.id ?? '',
				decision: 'deny',
				message: 'Not allowed. Reply with the word REFUSED.',
			});

			const done = await waitForState({ store, predicate: isIdle, label: 'turn end' });
			expect(existsSync(join(dir, 'denied.txt'))).toBe(false);
			expect(JSON.stringify(findLastText(done))).toContain('REFUSED');
		},
		TIMEOUT_MS,
	);

	it(
		'AskUserQuestion → answered through the store, Claude uses the answer',
		async () => {
			store.dispatch({
				type: 'send',
				ref: REF,
				text: 'Use the AskUserQuestion tool to ask me which color I prefer with options Red and Blue. Then reply with one line: PICKED: <color>.',
			});
			const asked = await waitForState({
				store,
				predicate: (state) => state.asks.some((ask) => ask.kind === 'question'),
				label: 'question',
			});
			const ask = asked.asks.find((candidate) => candidate.kind === 'question');

			if (ask?.kind !== 'question') {
				throw new Error('no question ask');
			}

			store.dispatch({
				type: 'answer_question',
				askId: ask.id,
				answers: { [ask.questions[0]?.question ?? '']: 'Blue' },
			});

			const done = await waitForState({ store, predicate: isIdle, label: 'turn end' });
			expect(JSON.stringify(readSession(done).stream)).toContain('Blue');
		},
		TIMEOUT_MS,
	);

	it(
		'interrupt mid-turn → turn ends, queue cleared',
		async () => {
			store.dispatch({ type: 'send', ref: REF, text: 'Write a 500-word essay about bridges.' });
			store.dispatch({ type: 'send', ref: REF, text: 'queued behind the essay' });
			await waitForState({
				store,
				predicate: (state) => readSession(state).draft.length > 20,
				label: 'streaming text',
			});
			store.dispatch({ type: 'interrupt', ref: REF });

			const done = await waitForState({
				store,
				predicate: isIdle,
				label: 'idle after interrupt',
				timeoutMs: 30_000,
			});
			expect(readSession(done).queue).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		'env → the worker never sees the API key (subscription billing)',
		async () => {
			if (isApiKeyAuth) {
				return;
			}

			store.dispatch({
				type: 'send',
				ref: REF,
				text: 'Run this bash command and reply with its exact output only: echo "KEY=${ANTHROPIC_API_KEY:-none}"',
			});
			const asked = await waitForState({
				store,
				predicate: (state) => state.asks.length > 0 || isIdle(state),
				label: 'ask or end',
			});

			if (asked.asks[0]) {
				store.dispatch({ type: 'answer_permission', askId: asked.asks[0].id, decision: 'allow' });
			}

			const done = await waitForState({ store, predicate: isIdle, label: 'turn end' });
			expect(JSON.stringify(readSession(done).stream)).toContain('KEY=none');
		},
		TIMEOUT_MS,
	);

	it(
		'resume → a new process continues the same conversation',
		async () => {
			store.dispatch({
				type: 'send',
				ref: REF,
				text: 'Remember the secret word: pelican. Reply OK.',
			});
			await waitForState({ store, predicate: isIdle, label: 'turn end' });
			const firstId = loadRegistry(registryFile)[REF]?.sessionId;
			store.dispatch({ type: 'stop_session', ref: REF });
			manager.stopAll();

			bootManager('default');
			store.dispatch({
				type: 'send',
				ref: REF,
				text: 'What secret word did I give you? Reply with the word only.',
			});
			const done = await waitForState({
				store,
				predicate: (state) =>
					isIdle(state) && readSession(state).stream.some((item) => item.kind === 'text'),
				label: 'resumed answer',
			});

			expect(findLastText(done)).toMatchObject({ kind: 'text' });
			expect(JSON.stringify(findLastText(done))).toMatch(/pelican/i);
			expect(loadRegistry(registryFile)[REF]?.sessionId).toBe(firstId);
		},
		TIMEOUT_MS,
	);

	it(
		'restart → the cockpit stream is rebuilt from the real transcript',
		async () => {
			const freshStore = new Store();
			freshStore.dispatch({
				type: 'worktrees',
				worktrees: [{ ref: REF, label: REF, branch: 'main', cwd: dir, dirs: [], isPinned: false }],
			});
			await restoreHistory({
				store: freshStore,
				sessions: loadRegistry(registryFile),
				getCwd: (ref) => freshStore.state.sessions[ref]?.cwd ?? null,
				loadMessages: loadTranscript,
			});
			const stream = freshStore.state.sessions[REF]?.stream ?? [];
			expect(stream).toContainEqual(
				expect.objectContaining({
					kind: 'user',
					text: expect.stringContaining('Remember the secret word: pelican'),
				}),
			);
			expect(stream.some((item) => item.kind === 'text')).toBe(true);
			expect(stream.some((item) => item.kind === 'tool' && item.name === 'Bash')).toBe(true);
		},
		TIMEOUT_MS,
	);

	it('registry file is valid JSON after all of the above', () => {
		expect(() => JSON.parse(readFileSync(registryFile, 'utf8'))).not.toThrow();
	});
});
