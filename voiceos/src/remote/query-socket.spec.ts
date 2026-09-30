// A remote's crew asking the main, end to end: a real query.sock, the real host, the real link over
// the in-memory network, and only the main's crew faked.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrewRunner, CrewRunResult } from '../crew/adapter.js';
import { configureLog } from '../log.js';
import { createSetupWorktree } from '../sessions/setup-session.js';
import { Store } from '../state/store.js';
import { createNetwork, until } from '../../test/support/link.js';
import { RemoteHost } from './host.js';
import { MachineLinks } from './links.js';
import { listenQuerySocket, parseQueryRequest, type QueryAnswer } from './query-socket.js';

configureLog({ quiet: true });

interface QueryFixture {
	request: { args: string[] };
	answered: Extract<QueryAnswer, { ok: true }>;
	noMain: QueryAnswer;
	timeout: QueryAnswer;
	failed: QueryAnswer;
}

const FIXTURE = JSON.parse(
	readFileSync(join(import.meta.dir, '../../test/fixtures/shared/query-socket.json'), 'utf8'),
) as QueryFixture;

const VM1 = { id: 'vm1', host: 'vm1', name: 'Build box' };

const stops: (() => void)[] = [];

afterEach(() => {
	for (const stop of stops.splice(0)) {
		stop();
	}
});

interface RemoteOptions {
	queryTimeoutMs?: number;
}

const startRemote = ({ queryTimeoutMs }: RemoteOptions = {}) => {
	const host = new RemoteHost({
		version: 'test',
		host: 'vm1',
		createManager: () => ({ handle: () => undefined, listRunning: () => [] }),
		listWorktrees: async () => [],
		runCrew: async () => ({ code: 0, stdout: '', stderr: '' }),
		readGitHead: async () => null,
		readMedia: () => null,
		restoreHistory: async () => undefined,
		...(queryTimeoutMs ? { queryTimeoutMs } : {}),
	});
	const path = join(mkdtempSync(join(tmpdir(), 'voiceos-query-')), 'query.sock');
	const socket = listenQuerySocket({ path, askMain: host.query });

	stops.push(() => socket.stop());

	return { host, path };
};

const startMain = (host: RemoteHost, runLocalCrew: CrewRunner) => {
	const store = new Store();
	const links = new MachineLinks({
		version: 'test',
		mainId: 'main-1',
		runId: 'run-1',
		open: createNetwork(host).open,
		updateRemote: async () => ({ code: 0, output: '', isTimedOut: false }),
		runLocalCrew,
		setup: createSetupWorktree('/h'),
		getState: () => store.state,
		dispatch: (input) => store.dispatch(input),
		storeMedia: () => true,
		say: () => undefined,
		handleLocal: () => undefined,
		retryMs: 60_000,
	});

	store.subscribe(() => queueMicrotask(() => links.sync()));
	store.dispatch({ type: 'machines', machines: [VM1] });
	stops.push(() => links.stopAll());

	return { store, links };
};

const connectedMain = async (host: RemoteHost, runLocalCrew: CrewRunner) => {
	const main = startMain(host, runLocalCrew);

	await until(() => main.store.state.machines.vm1?.status === 'connected', 'connected');

	return main;
};

// What crew's client does: one line out, everything until the daemon ends the connection back.
const ask = (path: string, line: string): Promise<QueryAnswer> =>
	new Promise((resolve, reject) => {
		const decoder = new TextDecoder();
		let text = '';

		Bun.connect({
			unix: path,
			socket: {
				open(socket) {
					socket.write(`${line}\n`);
				},
				data(_socket, chunk) {
					text += decoder.decode(chunk, { stream: true });
				},
				close() {
					try {
						resolve(JSON.parse(text) as QueryAnswer);
					} catch (error) {
						reject(new Error(`not one answer line: ${text} (${String(error)})`));
					}
				},
				error(_socket, error) {
					reject(error);
				},
			},
		}).catch(reject);
	});

const askArgs = (path: string, args: string[]): Promise<QueryAnswer> =>
	ask(path, JSON.stringify({ args }));

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a query from a remote to the main', () => {
	it('the shared fixture request → run by the main as sent; stdout, stderr and code intact', async () => {
		const { host, path } = startRemote();
		const ran: string[][] = [];

		await connectedMain(host, async (args) => {
			ran.push(args);

			return { ...FIXTURE.answered.value, code: 3 };
		});

		expect(await ask(path, JSON.stringify(FIXTURE.request))).toEqual({
			...FIXTURE.answered,
			value: { ...FIXTURE.answered.value, code: 3 },
		});
		expect(ran).toEqual([FIXTURE.request.args]);
	});

	it('the socket is 0600', () => {
		const { path } = startRemote();

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it('two queries in flight → each answered to the client that asked', async () => {
		const { host, path } = startRemote();

		await connectedMain(host, async (args) => {
			const grep = args.find((arg) => arg.startsWith('--grep=')) ?? '';

			await delay(grep === '--grep=a' ? 30 : 0);

			return { code: 0, stdout: grep, stderr: '' };
		});

		const [first, second] = await Promise.all([
			askArgs(path, ['voice', 'logs', '--grep=a', '--lines=80']),
			askArgs(path, ['voice', 'logs', '--grep=b', '--lines=80']),
		]);

		expect(first).toMatchObject({ ok: true, value: { stdout: '--grep=a' } });
		expect(second).toMatchObject({ ok: true, value: { stdout: '--grep=b' } });
	});

	it('several queries at once → the main runs one at a time, and answers them all', async () => {
		const { host, path } = startRemote();
		let running = 0;
		let mostAtOnce = 0;

		await connectedMain(host, async (args) => {
			running++;
			mostAtOnce = Math.max(mostAtOnce, running);
			await delay(10);
			running--;

			return { code: 0, stdout: args[2] ?? '', stderr: '' };
		});

		const answers = await Promise.all(
			['--grep=a', '--grep=b', '--grep=c'].map((grep) =>
				askArgs(path, ['voice', 'logs', grep, '--lines=80']),
			),
		);

		expect(answers.map((answer) => (answer.ok ? answer.value.stdout : answer.error))).toEqual([
			'--grep=a',
			'--grep=b',
			'--grep=c',
		]);
		expect(mostAtOnce).toBe(1);
	});

	it('a query queued behind one whose link dropped → both answered at once; the queued one never run', async () => {
		const { host, path } = startRemote();
		const held = Promise.withResolvers<CrewRunResult>();
		const ran: string[][] = [];
		const { links } = await connectedMain(host, (args) => {
			ran.push(args);

			return held.promise;
		});

		const first = askArgs(path, ['voice', 'logs', '--grep=a', '--lines=80']);

		await until(() => ran.length === 1, 'the first query ran');

		const second = askArgs(path, ['voice', 'logs', '--grep=b', '--lines=80']);

		// The second reached the main and waits behind the first.
		await delay(20);
		links.stopAll();

		expect(await Promise.all([first, second])).toEqual([
			{ ok: false, reason: 'no-main', error: 'the main disconnected' },
			{ ok: false, reason: 'no-main', error: 'the main disconnected' },
		]);

		held.resolve({ code: 0, stdout: '', stderr: '' });
		await delay(20);

		expect(ran.map((args) => args[2])).toEqual(['--grep=a']);
	});

	it('the main answers after the timeout → the timeout answered; the late answer dropped', async () => {
		const { host, path } = startRemote({ queryTimeoutMs: 40 });
		let calls = 0;

		await connectedMain(host, async () => {
			calls++;

			if (calls === 1) {
				await delay(120);

				return { code: 0, stdout: 'late', stderr: '' };
			}

			return { code: 0, stdout: 'second', stderr: '' };
		});

		const first = await askArgs(path, ['voice', 'logs', '--lines=80']);

		// The fixture says 30s; this test waits less.
		for (const answer of [first, FIXTURE.timeout]) {
			expect(answer).toMatchObject({ ok: false, reason: 'timeout' });
			expect(answer.ok ? '' : answer.error).toMatch(/^the main did not answer in \d+s$/);
		}

		await delay(150);

		expect(await askArgs(path, ['voice', 'logs', '--lines=80'])).toMatchObject({
			ok: true,
			value: { stdout: 'second' },
		});
	});

	it('the link drops mid-query → answered at once, not after the timeout', async () => {
		const { host, path } = startRemote();
		const held = Promise.withResolvers<CrewRunResult>();
		let hasStarted = false;
		const { links } = await connectedMain(host, () => {
			hasStarted = true;

			return held.promise;
		});

		const answer = askArgs(path, ['voice', 'logs', '--lines=80']);

		await until(() => hasStarted, 'the main ran crew');
		links.stopAll();

		expect(await answer).toEqual({ ok: false, reason: 'no-main', error: 'the main disconnected' });
		held.resolve({ code: 0, stdout: '', stderr: '' });
	});

	it('no main attached → the fixture refusal, at once', async () => {
		const { path } = startRemote();

		expect(await ask(path, JSON.stringify(FIXTURE.request))).toEqual(FIXTURE.noMain);
	});

	it('output over 2 MB → the fixture error, never cut JSON', async () => {
		const { host, path } = startRemote();

		await connectedMain(host, async () => ({
			code: 0,
			stdout: 'x'.repeat(2 * 1024 * 1024 + 1),
			stderr: '',
		}));

		expect(await ask(path, JSON.stringify(FIXTURE.request))).toEqual(FIXTURE.failed);
	});

	it('a command the main does not allow → refused there, never run', async () => {
		const { host, path } = startRemote();
		const ran: string[][] = [];

		await connectedMain(host, async (args) => {
			ran.push(args);

			return { code: 0, stdout: '', stderr: '' };
		});

		expect(await askArgs(path, ['voice', 'logs', '--local'])).toEqual({
			ok: false,
			reason: 'error',
			error: 'not allowed',
		});
		expect(ran).toEqual([]);
	});

	it('a line that is not a request → an error answer', async () => {
		const { path } = startRemote();

		expect(await ask(path, 'hello')).toEqual({
			ok: false,
			reason: 'error',
			error: 'not a query request',
		});
	});
});

describe('parseQueryRequest', () => {
	it('the fixture request → its args; past the bounds → null', () => {
		expect(parseQueryRequest(JSON.stringify(FIXTURE.request))).toEqual(FIXTURE.request.args);
		expect(parseQueryRequest(JSON.stringify({ args: Array.from({ length: 21 }, () => 'x') }))).toBe(
			null,
		);
		expect(parseQueryRequest('{"args":"voice logs"}')).toBe(null);
	});
});
