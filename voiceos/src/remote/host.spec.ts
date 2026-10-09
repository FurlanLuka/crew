import { describe, expect, it } from 'bun:test';
import { configureLog } from '../log.js';
import type { Observation } from '../shared/protocol.js';
import { worktree } from '../../test/support/reduce.js';
import {
	RemoteHost,
	describeVersionRefusal,
	isAllowedCrewCall,
	planCrewCall,
	type HandsManager,
} from './host.js';
import type { HandsEffect } from './mapping.js';
import { encodeLine, parseRemoteLine, SILENCE_LIMIT_MS, type RemoteMessage } from './protocol.js';

configureLog({ quiet: true });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// A host with a stand-in manager: records what it was asked, and reports through `emit`.
const createHost = () => {
	const clock = { now: 1_000 };
	const handled: HandsEffect[] = [];
	const running = new Set<string>();
	let emit: (observation: Observation) => void = () => undefined;
	const manager: HandsManager = {
		handle: (effect) => {
			handled.push(effect);
		},
		listRunning: () => [...running],
	};
	const host = new RemoteHost({
		version: 'test',
		host: 'vm1',
		createManager: (port) => {
			emit = port.emit;

			return manager;
		},
		listWorktrees: async () => [worktree('store/main')],
		// Echoes what it was asked: the argv, and what came on stdin after a '<'.
		runCrew: async (args, options) => ({
			code: 0,
			stdout: [args.join(' '), ...(options?.stdin ? [`< ${options.stdin}`] : [])].join(' '),
			stderr: '',
		}),
		readGitHead: async () => 'abc123',
		readMedia: (name) => (name === 'shot.png' ? PNG : null),
		restoreHistory: async () => undefined,
		now: () => clock.now,
	});

	return { host, handled, running, clock, emit: (observation: Observation) => emit(observation) };
};

const connect = (host: RemoteHost) => {
	const received: RemoteMessage[] = [];
	let isClosed = false;
	const link = host.connect({
		write: (text) => {
			for (const line of text.split('\n').filter(Boolean)) {
				const parsed = parseRemoteLine(line);

				if (parsed.ok) {
					received.push(parsed.message);
				}
			}
		},
		close: () => {
			isClosed = true;
		},
	});
	const say = (message: Parameters<typeof encodeLine>[0]) =>
		link.receive(encodeLine(message).trim());

	return { received, say, link, isClosed: () => isClosed };
};

const hello = (mainId = 'main-1', runId = 'run-1') => ({
	type: 'hello' as const,
	version: 'test',
	mainId,
	runId,
	pending: [],
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('RemoteHost', () => {
	it('the same main again (its old link half open) → takes over; the old link is closed', () => {
		const { host } = createHost();
		const first = connect(host);
		const second = connect(host);

		first.say(hello('main-1', 'run-1'));
		second.say(hello('main-1', 'run-2'));

		expect(first.isClosed()).toBe(true);
		expect(second.received[0]?.type).toBe('hello');
	});

	it('another main → refused as held; the first keeps the machine', () => {
		const { host } = createHost();
		const first = connect(host);
		const other = connect(host);

		first.say(hello('main-1'));
		other.say(hello('main-2'));

		expect(other.received).toEqual([
			{ type: 'refused', reason: 'held', detail: 'Another Voice OS drives this machine.' },
		]);
		expect(first.isClosed()).toBe(false);
	});

	it('another release → refused, saying what to do', () => {
		const { host } = createHost();
		const main = connect(host);

		main.say({ ...hello(), version: 'other' });

		expect(main.received[0]).toMatchObject({ type: 'refused', reason: 'version' });
		expect(main.isClosed()).toBe(true);
	});

	it('a main silent past the limit → dropped, so its reconnect is not refused', () => {
		const { host, clock } = createHost();
		const main = connect(host);

		main.say(hello());
		clock.now += SILENCE_LIMIT_MS + 1;
		host.dropSilent();

		expect(main.isClosed()).toBe(true);
	});

	it('a send to a session not running here → reported stopped, not lost silently', async () => {
		const { host, handled } = createHost();
		const main = connect(host);

		main.say(hello());
		main.say({
			type: 'effect',
			seq: 1,
			effect: { type: 'worker_send', ref: 'store/main', text: 'hi' },
		});
		await tick();

		expect(handled).toEqual([]);
		expect(main.received).toContainEqual({
			type: 'input',
			input: { type: 'worker_exited', ref: 'store/main', error: 'It was not running.' },
		});
	});

	it('the same effect twice (resent after a drop) → applied once, acknowledged', () => {
		const { host, handled } = createHost();
		const main = connect(host);
		const start = { type: 'worker_start' as const, ref: 'store/main', mode: 'auto' as const };

		main.say(hello());
		main.say({ type: 'effect', seq: 1, effect: start });
		main.say({ type: 'effect', seq: 1, effect: start });

		expect(handled).toEqual([start]);
		expect(main.received.filter((message) => message.type === 'ack')).toEqual([
			{ type: 'ack', upTo: 1 },
			{ type: 'ack', upTo: 1 },
		]);
	});

	it("an image → its bytes go first, once per link; a turn's end carries its id and commit", async () => {
		const { host, emit } = createHost();

		await host.refreshWorktrees();

		const main = connect(host);

		main.say(hello());
		emit({ type: 'image', ref: 'store/main', name: 'shot.png', alt: '' });
		emit({ type: 'image', ref: 'store/main', name: 'shot.png', alt: '' });
		emit({ type: 'turn_ended', ref: 'store/main', costUsd: 0, text: 'done' });
		await tick();

		const kinds = main.received.map((message) =>
			message.type === 'input' ? message.input.type : message.type,
		);

		expect(kinds.slice(1)).toEqual(['media', 'image', 'image', 'turn_ended']);
		expect(main.received.at(-1)).toMatchObject({
			type: 'input',
			input: { type: 'turn_ended', head: 'abc123', turnId: expect.stringMatching(/-1$/) },
		});
	});

	it('crew calls → dev commands answered; anything else refused', async () => {
		const { host } = createHost();
		const main = connect(host);

		main.say(hello());
		main.say({ type: 'call', id: 1, method: 'crew', args: ['dev', 'status', '--json'] });
		main.say({ type: 'call', id: 2, method: 'crew', args: ['rm', 'workspace', 'store'] });
		await tick();

		expect(main.received).toContainEqual({
			type: 'result',
			id: 1,
			ok: true,
			value: { code: 0, stdout: 'dev status --json', stderr: '' },
		});
		expect(main.received).toContainEqual({
			type: 'result',
			id: 2,
			ok: false,
			error: 'not allowed',
		});
	});
});

describe("Set up's typed commands from the main", () => {
	const answerTo = async (call: Record<string, unknown>) => {
		const { host } = createHost();
		const main = connect(host);

		main.say(hello());
		main.say({ type: 'call', id: 1, method: 'crew', args: [], ...call } as never);
		await tick();

		return main.received.find((message) => message.type === 'result');
	};

	it('→ built into argv here and run, whatever args say: the command is the truth', async () => {
		expect(
			await answerTo({
				args: ['dev', 'status', '--json'],
				command: { type: 'rm_worktree', ref: 'store/wrk1', confirm: true },
			}),
		).toEqual({
			type: 'result',
			id: 1,
			ok: true,
			value: { code: 0, stdout: 'rm worktree store/wrk1', stderr: '' },
		});
	});

	it('a bundle → on stdin, not in argv', async () => {
		expect(
			await answerTo({ command: { type: 'import_plan', bundle: '{"version":2}' } }),
		).toMatchObject({ ok: true, value: { stdout: 'import - --plan --json < {"version":2}' } });
	});

	it('not a command crew/commands.ts knows → refused with the fields that failed', async () => {
		expect(await answerTo({ command: { type: 'rm_worktree', ref: 'store/wrk1' } })).toEqual({
			type: 'result',
			id: 1,
			ok: false,
			error: 'invalid command: confirm',
		});
	});

	it("local-only (it would stop, replace or re-key this machine's server) → refused", async () => {
		for (const command of [
			{ type: 'server_restart' },
			{ type: 'uninstall', mode: 'purge', confirm: true },
			{ type: 'keys_set', name: 'soniox', value: 'sk' },
		]) {
			expect(await answerTo({ command })).toMatchObject({ ok: false });
		}
	});
});

describe('planCrewCall', () => {
	it('no command → the dev-watch allow-list as before', () => {
		expect(planCrewCall({ args: ['dev', 'status', '--json'] })).toEqual({
			ok: true,
			args: ['dev', 'status', '--json'],
			label: 'dev status',
		});
		expect(planCrewCall({ args: ['rm', 'workspace', 'store'] })).toEqual({
			ok: false,
			reason: 'args',
			error: 'not allowed',
		});
	});

	it('a command → its argv and stdin, labelled by its type alone (never a value)', () => {
		expect(
			planCrewCall({
				args: [],
				command: { type: 'add_override', ref: 'a/b', var: 'TOKEN', value: 'secret' },
			}),
		).toEqual({
			ok: true,
			args: ['add', 'override', 'a/b', 'TOKEN=secret'],
			label: 'add_override',
			timeoutMs: 120_000,
		});
	});

	it("a command's timeout is its variant's, not the wire's capped one", () => {
		expect(
			planCrewCall({
				args: [],
				timeoutMs: 300_000,
				command: { type: 'add_worktree', ref: 'store/wrk2' },
			}),
		).toMatchObject({ ok: true, timeoutMs: 600_000 });
		expect(planCrewCall({ args: ['dev', 'check', 'a/b', '--json'], timeoutMs: 75_000 })).toEqual({
			ok: true,
			args: ['dev', 'check', 'a/b', '--json'],
			label: 'dev check',
			timeoutMs: 75_000,
		});
	});
});

describe('a line from the main that does not parse', () => {
	it('→ dropped; the main stays attached and its next call is answered', async () => {
		const { host } = createHost();
		const main = connect(host);

		main.say(hello());
		main.link.receive('not json at all');
		main.link.receive('{"type":"nonsense"}');
		main.say({ type: 'call', id: 1, method: 'crew', args: ['dev', 'status', '--json'] });
		await tick();

		expect(main.isClosed()).toBe(false);
		expect(main.received).toContainEqual({
			type: 'result',
			id: 1,
			ok: true,
			value: { code: 0, stdout: 'dev status --json', stderr: '' },
		});
	});
});

describe('isAllowedCrewCall', () => {
	it.each([
		[['dev', 'status', '--json'], true],
		[['dev', 'check', 'store/main', '--json', '--wait'], true],
		[['dev', 'start', 'store/main', '--json'], true],
		[['fix', 'store/main', '--print'], true],
		[['dev', 'rm', 'store', 'api'], false],
		[['dev', 'proxy', 'stop'], false],
		[['dev', 'start', 'a/b', 'c/d'], false],
		[['dev', 'start', 'a/b', '--apply'], false],
		[['fix', '--print', 'store/main'], false],
		[['fix', 'store/main', '--print', '--yes'], false],
		[['rm', 'workspace', 'store'], false],
	])('%p → %p', (args, isAllowed) => {
		expect(isAllowedCrewCall(args as string[])).toBe(isAllowed);
	});
});

describe('what a remote sends', () => {
	it("its own usage limits → kept here, never sent (the main's are its own login's)", async () => {
		const { host, emit } = createHost();
		const main = connect(host);

		main.say(hello());
		emit({ type: 'limits', limits: { fiveHour: 10, sevenDay: 20, resetsAt: null } });
		emit({ type: 'turn_started', ref: 'store/main' });
		await tick();

		expect(main.received.filter((message) => message.type === 'input')).toEqual([
			{ type: 'input', input: { type: 'turn_started', ref: 'store/main' } },
		]);
	});
});

describe('describeVersionRefusal', () => {
	it('two releases → crew update on the older one', () => {
		expect(describeVersionRefusal('5.7.1', '5.8.0')).toBe(
			'This machine runs Voice OS 5.7.1 and the main 5.8.0: run crew update on the older one, then crew server remote there.',
		);
	});

	it('a dev build on this machine → the same hint', () => {
		expect(describeVersionRefusal('dev-abc1234', '5.8.0')).toContain('run crew server dev push');
	});

	it('a dev build on either side → a dev push, or crew update back to the release', () => {
		expect(describeVersionRefusal('5.7.1', 'dev-abc1234')).toBe(
			'This machine runs Voice OS 5.7.1 and the main dev-abc1234: run crew server dev push from the checkout you want on every machine, or crew update on each to go back to the release.',
		);
	});
});
