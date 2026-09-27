import { describe, expect, it } from 'bun:test';
import type { Observation } from '../shared/protocol.js';
import { PermissionBridge } from './permissions.js';
import { Worker, buildWorkerEnv } from './worker.js';

const base = {
	PATH: '/usr/bin',
	ANTHROPIC_API_KEY: 'k',
	ANTHROPIC_AUTH_TOKEN: 't',
	SONIOX_API_KEY: 's',
	VOICEOS_ANTHROPIC_API_KEY: 'v',
	HOME: '/wrong',
};

describe('buildWorkerEnv', () => {
	it('strips every key that would change billing or leak speech credentials', () => {
		const env = buildWorkerEnv({
			base,
			ref: 'store/main',
			home: '/Users/me',
			shouldKeepApiKey: false,
		});

		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(env.SONIOX_API_KEY).toBeUndefined();
		expect(env.VOICEOS_ANTHROPIC_API_KEY).toBeUndefined();

		// Removed, not set to undefined: a child process given the key at all could pick it up.
		for (const key of [
			'ANTHROPIC_API_KEY',
			'ANTHROPIC_AUTH_TOKEN',
			'SONIOX_API_KEY',
			'VOICEOS_ANTHROPIC_API_KEY',
		]) {
			expect(key in env).toBe(false);
		}
	});

	it('sets HOME explicitly and CREW_REF like crew claude does', () => {
		expect(
			buildWorkerEnv({ base, ref: 'store/main', home: '/Users/me', shouldKeepApiKey: false }),
		).toMatchObject({ HOME: '/Users/me', CREW_REF: 'store/main', PATH: '/usr/bin' });
	});

	it('keepApiKey (tests only) → keeps ANTHROPIC_API_KEY, still strips the rest', () => {
		const env = buildWorkerEnv({ base, ref: 'r', home: '/h', shouldKeepApiKey: true });

		expect(env.ANTHROPIC_API_KEY).toBe('k');
		expect(env.SONIOX_API_KEY).toBeUndefined();
	});

	it('does not mutate the base env', () => {
		buildWorkerEnv({ base, ref: 'r', home: '/h', shouldKeepApiKey: false });
		expect(base.ANTHROPIC_API_KEY).toBe('k');
	});
});

describe('Worker', () => {
	const createWorker = (messages: unknown[]) => {
		const prompts: string[] = [];
		const sessionIds: string[] = [];
		const observations: Observation[] = [];
		const finished = Promise.withResolvers<void>();
		const worker = new Worker({
			ref: 'store/main',
			cwd: '/w',
			dirs: [],
			orientation: '',
			resumeId: null,
			env: {},
			permissions: new PermissionBridge(
				() => undefined,
				() => undefined,
			),
			emit: (observation) => {
				observations.push(observation);

				if (observation.type === 'worker_exited') {
					finished.resolve();
				}
			},
			onSessionId: (sessionId) => sessionIds.push(sessionId),
			onResumeFailed: () => undefined,
			briefing: { pending: true, onBriefed: () => undefined },
			runQuery: ((call: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
				void (async () => {
					for await (const message of call.prompt) {
						prompts.push(message.message.content);
					}
				})();

				return {
					async *[Symbol.asyncIterator]() {
						yield* messages;
					},
				};
			}) as never,
		});

		return { worker, prompts, sessionIds, observations, finished: finished.promise };
	};

	it('a /clear goes to the CLI as typed: no note, no briefing, and the briefing waits for the next message', async () => {
		const { worker, prompts } = createWorker([]);

		worker.start();
		worker.send('/clear', 'Voice OS note');
		worker.send('run the tests');

		while (prompts.length < 2) {
			await Bun.sleep(1);
		}

		expect(prompts[0]).toBe('/clear');
		expect(prompts[1]).not.toBe('run the tests');
		expect(prompts[1]).toContain('run the tests');
	});

	it('follows a /clear to the conversation the next init names, not the announced id', async () => {
		const { worker, sessionIds, finished } = createWorker([
			{ type: 'system', subtype: 'init', session_id: 'old' },
			{ type: 'user', uuid: 'u1', message: { content: 'hi' } },
			// The CLI's own sequence, seen live: new_conversation_id is not the transcript that resumes.
			{ type: 'conversation_reset', new_conversation_id: 'announced' },
			{ type: 'system', subtype: 'init', session_id: 'new' },
			{ type: 'system', subtype: 'init', session_id: 'new' },
		]);

		worker.start();
		await finished;

		expect(worker.id).toBe('new');
		expect(sessionIds).toEqual(['old', 'new']);
	});
});
