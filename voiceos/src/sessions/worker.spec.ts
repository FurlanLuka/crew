import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
	it('a worktree gets CREW_REF; a plain session gets none, so crew never thinks it is in a worktree', () => {
		const params = { home: '/Users/me', shouldKeepApiKey: false };

		expect(buildWorkerEnv({ base, ref: 'store/main', ...params }).CREW_REF).toBe('store/main');
		expect('CREW_REF' in buildWorkerEnv({ base, ref: 'chat/3fa9c1', ...params })).toBe(false);
	});

	it("turns on the SDK's Artifact tools; a developer's own setting, 0 included, stands", () => {
		const params = { ref: 'store/main', home: '/Users/me', shouldKeepApiKey: false };

		expect(buildWorkerEnv({ base, ...params }).CLAUDE_CODE_ARTIFACT).toBe('1');
		expect(
			buildWorkerEnv({ base: { ...base, CLAUDE_CODE_ARTIFACT: '0' }, ...params })
				.CLAUDE_CODE_ARTIFACT,
		).toBe('0');
	});

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
	const createWorker = (
		messages: unknown[],
		extra: { mediaDir?: string; isPinned?: boolean; env?: Record<string, string> } = {},
	) => {
		const prompts: string[] = [];
		const queryOptions: { env?: Record<string, string | undefined> }[] = [];
		const sessionIds: string[] = [];
		const observations: Observation[] = [];
		const finished = Promise.withResolvers<void>();
		const worker = new Worker({
			ref: 'store/main',
			cwd: '/w',
			dirs: [],
			isPinned: false,
			...extra,
			orientation: '',
			resumeId: null,
			env: extra.env ?? {},
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
			runQuery: ((call: {
				prompt: AsyncIterable<{ message: { content: string } }>;
				options: { env?: Record<string, string | undefined> };
			}) => {
				queryOptions.push(call.options);

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

		return {
			worker,
			prompts,
			sessionIds,
			observations,
			queryOptions,
			finished: finished.promise,
		};
	};

	// The env is what strips the API key (billing) and turns on the Artifact tools: it must reach the SDK.
	it('the session runs with exactly the env it was given', () => {
		const env = { CREW_REF: 'store/main', CLAUDE_CODE_ARTIFACT: '1', HOME: '/Users/me' };
		const { worker, queryOptions } = createWorker([], { env });

		worker.start();

		expect(queryOptions.map((options) => options.env)).toEqual([env]);
	});

	// Without it the SDK forwards only a sub-agent's calls: its transcript on the page would be empty.
	it("the session asks for its sub-agents' own text", () => {
		const { worker, queryOptions } = createWorker([]);

		worker.start();

		expect(
			queryOptions.map(
				(options) => (options as { forwardSubagentText?: boolean }).forwardSubagentText,
			),
		).toEqual([true]);
	});

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

	it("with a media folder, a tool's screenshot is stored and shown", async () => {
		const mediaDir = mkdtempSync(join(tmpdir(), 'worker-media-'));
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]).toString('base64');
		const { worker, observations, finished } = createWorker(
			[
				{ type: 'system', subtype: 'init', session_id: 's1' },
				{
					type: 'assistant',
					message: {
						content: [
							{
								type: 'tool_use',
								id: 't1',
								name: 'mcp__playwright__browser_take_screenshot',
								input: {},
							},
						],
					},
				},
				{
					type: 'user',
					message: {
						content: [
							{
								type: 'tool_result',
								tool_use_id: 't1',
								content: [
									{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
								],
							},
						],
					},
				},
			],
			{ mediaDir },
		);

		worker.start();
		await finished;

		const image = observations.find((observation) => observation.type === 'image');
		expect(image).toMatchObject({ type: 'image', ref: 'store/main' });
		expect(readdirSync(mediaDir)).toEqual([image?.type === 'image' ? image.name : 'none']);
		rmSync(mediaDir, { recursive: true, force: true });
	});

	it('the setup session (its folder is home) shows no image named from it', async () => {
		const mediaDir = mkdtempSync(join(tmpdir(), 'worker-media-'));
		const home = mkdtempSync(join(tmpdir(), 'worker-home-'));
		writeFileSync(
			join(home, 'shot.png'),
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
		);
		const { worker, observations, finished } = createWorker(
			[
				{ type: 'system', subtype: 'init', session_id: 's1' },
				{
					type: 'assistant',
					message: { content: [{ type: 'text', text: `Look: ![x](${join(home, 'shot.png')})` }] },
				},
			],
			{ mediaDir, isPinned: true },
		);

		worker.start();
		await finished;

		expect(observations.some((observation) => observation.type === 'image')).toBe(false);
		expect(readdirSync(mediaDir)).toEqual([]);
		rmSync(mediaDir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});
});
