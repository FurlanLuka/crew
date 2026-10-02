import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import { CallFailure } from '../remote/link.js';
import type { CrewRunOptions, CrewRunResult } from './adapter.js';
import { spawnRunner } from './adapter.js';
import { checkRequest } from '../gateway/auth.js';
import {
	createSetupRunner,
	handleCrewRequest,
	type SetupReply,
	type RunSetupCommand,
} from './api.js';
import type { SetupCommand } from './commands.js';

const ORIGIN = 'http://localhost:4100';
const ORIGINS = [ORIGIN, 'http://127.0.0.1:4100'];
const logFile = join(mkdtempSync(join(tmpdir(), 'voiceos-crew-api-')), 'voiceos.log');

beforeAll(() => configureLog({ quiet: true, file: logFile }));
afterAll(() => configureLog({ quiet: true }));

const readLog = (): string => {
	try {
		return readFileSync(logFile, 'utf8');
	} catch {
		return '';
	}
};

interface PostParams {
	body?: unknown;
	raw?: string;
	origin?: string | null;
	contentType?: string | null;
	isAuthorized?: boolean;
	method?: string;
	runCrew?: RunSetupCommand;
}

const ran = (stdout: string, code = 0, stderr = ''): SetupReply => ({
	kind: 'ran',
	result: { code, stdout, stderr },
});

const post = async ({
	body,
	raw,
	origin = ORIGIN,
	contentType = 'application/json',
	isAuthorized = true,
	method = 'POST',
	runCrew = async () => ran('[]'),
}: PostParams) => {
	const headers: Record<string, string> = {};

	if (origin) {
		headers.origin = origin;
	}

	if (contentType) {
		headers['content-type'] = contentType;
	}

	const request = new Request(`${ORIGIN}/api/crew`, {
		method,
		headers,
		...(method === 'POST' ? { body: raw ?? JSON.stringify(body) } : {}),
	});
	const response = await handleCrewRequest({ request, origins: ORIGINS, isAuthorized, runCrew });

	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
};

const LS = { machine: 'local', command: { type: 'ls_projects' } };

describe('checkRequest', () => {
	it.each([
		[ORIGIN, true, null],
		['http://127.0.0.1:4100', true, null],
		[null, true, 403],
		['http://evil.example', true, 403],
		['http://web--store--main.1.2.3.4.nip.io', true, 403],
		[ORIGIN, false, 401],
		['http://evil.example', false, 403],
	])('origin %p, authorized %p → %p', (origin, isAuthorized, status) => {
		const refusal = checkRequest({ origin, origins: ORIGINS, isAuthorized });

		expect(refusal?.status ?? null).toBe(status);
	});
});

describe('POST /api/crew', () => {
	const neverRun: RunSetupCommand = async () => {
		throw new Error('must not run');
	};

	it('a read → 200 with code, stdout, stderr and the parsed json', async () => {
		const runCrew: RunSetupCommand = async (machine, command) => {
			expect(machine).toBe('local');
			expect(command).toEqual({ type: 'ls_projects' });

			return ran('[{"name":"store-front"}]\n', 0, '');
		};

		expect(await post({ body: LS, runCrew })).toEqual({
			status: 200,
			json: {
				code: 0,
				stdout: '[{"name":"store-front"}]\n',
				stderr: '',
				json: [{ name: 'store-front' }],
			},
		});
	});

	it("crew's verdict (exit 1) → still 200: the page reads the code and crew's line", async () => {
		const runCrew: RunSetupCommand = async () => ran('', 1, 'Error: no project signals\n');
		const { status, json } = await post({
			body: { machine: 'local', command: { type: 'rm_project', name: 'signals', confirm: true } },
			runCrew,
		});

		expect(status).toBe(200);
		expect(json).toEqual({ code: 1, stdout: '', stderr: 'Error: no project signals\n' });
	});

	it('a text command → no json field, even when stdout happens to parse', async () => {
		const runCrew: RunSetupCommand = async () => ran('42\n');
		const { json } = await post({
			body: { machine: 'local', command: { type: 'debug_tail', lines: 5 } },
			runCrew,
		});

		expect(json).toEqual({ code: 0, stdout: '42\n', stderr: '' });
	});

	it.each([
		['no Origin', { origin: null }, 403],
		['a foreign Origin', { origin: 'http://evil.example' }, 403],
		['no cookie', { isAuthorized: false }, 401],
		['a form post', { contentType: 'application/x-www-form-urlencoded' }, 415],
		['no content type', { contentType: null }, 415],
		['a GET', { method: 'GET' }, 405],
		['not JSON', { raw: 'ls projects' }, 400],
		['no machine', { body: { command: { type: 'ls_projects' } } }, 400],
		['an extra field', { body: { ...LS, args: ['--purge'] } }, 400],
		['an unknown command', { body: { machine: 'local', command: { type: 'rm_rf' } } }, 400],
		[
			'a removal without confirm',
			{ body: { machine: 'local', command: { type: 'rm_worktree', ref: 'a/b' } } },
			400,
		],
		[
			'a flag as a positional',
			{ body: { machine: 'local', command: { type: 'show', ref: '--help' } } },
			400,
		],
	])('%s → %p, crew never run', async (_, params, status) => {
		const result = await post({ body: LS, ...params, runCrew: neverRun } as PostParams);

		expect(result.status).toBe(status);
	});

	it('a body that says it is too big → 413 before it is read', async () => {
		const request = new Request(`${ORIGIN}/api/crew`, {
			method: 'POST',
			headers: {
				origin: ORIGIN,
				'content-type': 'application/json',
				'content-length': String(7 * 1024 * 1024),
			},
			body: JSON.stringify(LS),
		});
		const text = request.text.bind(request);
		let wasRead = false;

		request.text = () => {
			wasRead = true;

			return text();
		};

		const response = await handleCrewRequest({
			request,
			origins: ORIGINS,
			isAuthorized: true,
			runCrew: neverRun,
		});

		expect(response.status).toBe(413);
		expect(wasRead).toBe(false);
	});

	it.each([
		['a form post (not JSON)', { contentType: 'text/plain', raw: 'machine=local' }, 415],
		['malformed JSON', { raw: '{"machine": "local", "command": {sk-live-oops' }, 400],
		['no command', { body: { machine: 'local' } }, 400],
	] as const)(
		'%s → %p, logged like every refusal: status and reason, never the body',
		async (_name, params, status) => {
			const before = readLog().length;
			const result = await post({ ...params, runCrew: neverRun });
			const logged = readLog().slice(before);

			expect(result.status).toBe(status);
			expect(logged).toContain('crew api refused');
			expect(logged).toContain(`"status":${status}`);
			expect(logged).toContain('"type":"unknown"');
			expect(logged).not.toContain('sk-live-oops');
			expect(logged).not.toContain('machine=local');
		},
	);

	it('a refused body is never echoed back', async () => {
		const { json } = await post({
			body: {
				machine: 'local',
				command: { type: 'add_override', ref: 'a/b', var: 'K', value: 'sk-live-secret', x: 1 },
			},
			runCrew: neverRun,
		});

		expect(JSON.stringify(json)).not.toContain('sk-live-secret');
	});

	it.each([
		['unknown_machine', 404],
		['local_only', 409],
		['offline', 502],
		['remote_outdated', 426],
		['timeout', 504],
	] as const)('%s → %p with the reason for the page', async (reason, status) => {
		const runCrew: RunSetupCommand = async () => ({
			kind: 'failed',
			reason,
			error: 'Build box runs an older crew',
			...(reason === 'remote_outdated' ? { version: '4.1.0' } : {}),
		});
		const result = await post({ body: { ...LS, machine: 'vm1' }, runCrew });

		expect(result.status).toBe(status);
		expect(result.json).toMatchObject({ reason, error: 'Build box runs an older crew' });

		if (reason === 'remote_outdated') {
			expect(result.json.version).toBe('4.1.0');
		}
	});

	it('a detached command → 202, nothing waited for', async () => {
		const runCrew: RunSetupCommand = async () => ({ kind: 'started' });
		const result = await post({
			body: { machine: 'local', command: { type: 'server_restart' } },
			runCrew,
		});

		expect(result).toEqual({ status: 202, json: { started: true } });
	});

	it('keys_set → the key reaches crew only in the command, never the reply or the log', async () => {
		const key = 'sk-ant-api03-very-secret-value';
		let seen = null as SetupCommand | null;

		const runCrew: RunSetupCommand = async (_machine, command) => {
			seen = command;

			return ran('{"saved":"anthropic","path":"/k/anthropic.key"}\n');
		};

		const { status, json } = await post({
			body: { machine: 'local', command: { type: 'keys_set', name: 'anthropic', value: key } },
			runCrew,
		});

		expect(status).toBe(200);
		expect(seen).toEqual({ type: 'keys_set', name: 'anthropic', value: key });
		expect(JSON.stringify(json)).not.toContain(key);
		expect(readLog()).not.toContain(key);
	});

	it("a rejected key → crew's rejection text on stderr, the code not 0", async () => {
		const runCrew: RunSetupCommand = async () =>
			ran('', 1, 'Error: Anthropic rejected the key (401): check it was copied whole\n');
		const { json } = await post({
			body: { machine: 'local', command: { type: 'keys_set', name: 'anthropic', value: 'bad' } },
			runCrew,
		});

		expect(json).toEqual({
			code: 1,
			stdout: '',
			stderr: 'Error: Anthropic rejected the key (401): check it was copied whole\n',
		});
	});

	it('logs name the command, the machine and the code — never a binding value or an output', async () => {
		const value = 'postgres://admin:hunter2@db.internal/store';
		const runCrew: RunSetupCommand = async () => ran(`DATABASE_URL=${value}\n`);

		await post({
			body: {
				machine: 'local',
				command: { type: 'add_binding', project: 'store-api', var: 'DATABASE_URL', value },
			},
			runCrew,
		});
		await post({
			body: {
				machine: 'local',
				command: { type: 'env', ref: 'store-front/main', project: 'store-api' },
			},
			runCrew,
		});

		const logged = readLog();

		expect(logged).toContain('"type":"add_binding"');
		expect(logged).toContain('"type":"env"');
		expect(logged).not.toContain('hunter2');
		expect(logged).not.toContain('DATABASE_URL');
	});
});

describe('createSetupRunner', () => {
	interface Call {
		args: string[];
		options?: CrewRunOptions;
	}

	interface CreateRunnerParams {
		link?: (command: SetupCommand) => Promise<CrewRunResult>;
		local?: CrewRunResult;
		startLocal?: (args: string[]) => void;
	}

	const createRunner = ({ link, local: localResult, startLocal }: CreateRunnerParams = {}) => {
		const local: Call[] = [];
		const started: string[][] = [];
		const run = createSetupRunner({
			runLocal: async (args, options) => {
				local.push({ args, ...(options ? { options } : {}) });

				return localResult ?? { code: 0, stdout: '', stderr: '' };
			},
			startLocal: startLocal ?? ((args) => void started.push(args)),
			getLink: (machine) => (machine === 'vm1' && link ? { runCommand: link } : undefined),
		});

		return { run, local, started };
	};

	it("local → crew's argv with the variant's timeout; a bundle on stdin, never in argv", async () => {
		const { run, local } = createRunner();

		await run('local', { type: 'import_plan', bundle: '{"version":2}' });

		expect(local).toEqual([
			{
				args: ['import', '-', '--plan', '--json'],
				options: { timeoutMs: 120_000, stdin: '{"version":2}' },
			},
		]);
	});

	it('local, replacing the server → started detached, 202 for the page', async () => {
		const { run, local, started } = createRunner();

		expect(await run('local', { type: 'uninstall', mode: 'keep', confirm: true })).toEqual({
			kind: 'started',
		});
		expect(started).toEqual([['uninstall', '--yes']]);
		expect(local).toEqual([]);
	});

	it('a machine with no link → unknown', async () => {
		const { run } = createRunner();

		expect(await run('vm9', { type: 'ls_projects' })).toMatchObject({
			kind: 'failed',
			reason: 'unknown_machine',
		});
	});

	it('a local-only command for another machine → refused before the link', async () => {
		const { run } = createRunner({
			link: async () => {
				throw new Error('must not reach the link');
			},
		});

		for (const command of [
			{ type: 'keys_set', name: 'soniox', value: 'k' },
			{ type: 'server_restart' },
			{ type: 'update' },
		] as SetupCommand[]) {
			expect(await run('vm1', command)).toMatchObject({ kind: 'failed', reason: 'local_only' });
		}
	});

	it("the link's failures → the reason for the page, an old remote's version kept", async () => {
		const failing = (failure: CallFailure) =>
			createRunner({
				link: async () => {
					throw failure;
				},
			}).run('vm1', { type: 'ls_projects' });

		expect(await failing(new CallFailure('offline', 'Build box is out of reach'))).toEqual({
			kind: 'failed',
			reason: 'offline',
			error: 'Build box is out of reach',
		});
		expect(
			await failing(new CallFailure('remote_outdated', 'Build box runs an older crew', '4.1.0')),
		).toEqual({
			kind: 'failed',
			reason: 'remote_outdated',
			error: 'Build box runs an older crew',
			version: '4.1.0',
		});
	});

	it('a remote that answers → its result as if run here', async () => {
		const { run } = createRunner({ link: async () => ({ code: 0, stdout: '[]', stderr: '' }) });

		expect(await run('vm1', { type: 'ls_worktrees' })).toEqual(ran('[]'));
	});

	it('crew killed for its timeout, here or on the remote → a timeout, never an answer', async () => {
		const killed: CrewRunResult = { code: 143, stdout: '', stderr: '', timedOut: true };
		const failure: SetupReply = {
			kind: 'failed',
			reason: 'timeout',
			error: 'crew did not finish in 600 s',
		};
		const command: SetupCommand = { type: 'add_worktree', ref: 'store-front/main' };

		expect(await createRunner({ local: killed }).run('local', command)).toEqual(failure);
		expect(await createRunner({ link: async () => killed }).run('vm1', command)).toEqual(failure);
	});

	it('a detached start that throws → failed offline, nothing of the argv logged', async () => {
		const { run } = createRunner({
			startLocal: () => {
				throw new Error('spawn crew uninstall --purge --yes ENOENT');
			},
		});

		expect(await run('local', { type: 'uninstall', mode: 'purge', confirm: true })).toEqual({
			kind: 'failed',
			reason: 'offline',
			error: 'crew could not be started',
		});
		expect(readLog()).not.toContain('--purge');
	});
});

describe('spawnRunner', () => {
	// A stand-in crew: CREW_BIN is read on each run.
	const fakeCrew = (script: string): string => {
		const file = join(mkdtempSync(join(tmpdir(), 'voiceos-fake-crew-')), 'crew');

		writeFileSync(file, `#!/bin/sh\n${script}\n`);
		chmodSync(file, 0o755);

		return file;
	};

	const withCrew = async <T>(script: string, run: () => Promise<T>): Promise<T> => {
		const previous = process.env.CREW_BIN;

		process.env.CREW_BIN = fakeCrew(script);

		try {
			return await run();
		} finally {
			if (previous === undefined) {
				delete process.env.CREW_BIN;
			} else {
				process.env.CREW_BIN = previous;
			}
		}
	};

	it('stdin given → crew reads it; args carry nothing of it', async () => {
		const result = await withCrew('echo "args:$*"; cat', () =>
			spawnRunner(['voice', 'keys', 'set', 'soniox'], { stdin: 'sk-test\n' }),
		);

		expect(result).toEqual({
			code: 0,
			stdout: 'args:voice keys set soniox\nsk-test\n',
			stderr: '',
		});
	});

	it('past its timeout → crew and the children it started are killed, the read does not wait', async () => {
		const pidFile = join(mkdtempSync(join(tmpdir(), 'voiceos-child-')), 'pid');
		const startedAt = Date.now();
		const result = await withCrew(`sleep 30 &\necho $! >"${pidFile}"\nwait`, () =>
			spawnRunner(['clean'], { timeoutMs: 500 }),
		);

		expect(result.timedOut).toBe(true);
		expect(Date.now() - startedAt).toBeLessThan(2_500);

		const child = Number(readFileSync(pidFile, 'utf8').trim());

		const isAlive = (): boolean => {
			try {
				process.kill(child, 0);

				return true;
			} catch {
				return false;
			}
		};

		// The signal is delivered; the kernel may take a beat to reap it.
		for (let tries = 0; tries < 20 && isAlive(); tries++) {
			await Bun.sleep(50);
		}

		expect(isAlive()).toBe(false);
	});

	it('past its timeout → killed, and the result says so', async () => {
		const startedAt = Date.now();
		const result = await withCrew('sleep 5', () => spawnRunner(['clean'], { timeoutMs: 100 }));

		expect(result.timedOut).toBe(true);
		expect(result.code).not.toBe(0);
		expect(Date.now() - startedAt).toBeLessThan(3_000);
	});
});
