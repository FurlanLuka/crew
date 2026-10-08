import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrewRunOptions, CrewRunResult } from '../crew/adapter.js';
import { createSetupRunner } from '../crew/api.js';
import { configureLog } from '../log.js';
import { SessionManager } from '../sessions/manager.js';
import { createSetupWorktree } from '../sessions/setup-session.js';
import { Store } from '../state/store.js';
import { createFakeQuery } from '../../test/support/fake-query.js';
import { createNetwork, until } from '../../test/support/link.js';
import { worktree } from '../../test/support/reduce.js';
import { isActive } from '../shared/active.js';
import { describeAttached, readAttachmentBytes, storeAttachment } from '../sessions/attachments.js';
import type { WorktreeInfo } from '../shared/protocol.js';
import { RemoteHost } from './host.js';
import { writeSecretFile, type SecretCopy } from '../sessions/secrets.js';
import { MachineLinks } from './links.js';
import { CallFailure, type OpenTransport } from './link.js';
import type { UpdateRemote } from './ssh.js';

configureLog({ quiet: true });

const VM1 = { id: 'vm1', host: 'vm1', name: 'Build box' };
const REF = 'vm1:store/main';

const stops: (() => void)[] = [];

afterEach(() => {
	for (const stop of stops.splice(0)) {
		stop();
	}
});

interface HostOptions {
	version?: string;
	worktrees?: WorktreeInfo[];
	runCrew?: (args: string[], options?: CrewRunOptions) => Promise<CrewRunResult>;
	attachmentsDir?: string;
	commands?: { name: string; description: string; argumentHint: string }[];
	// What a fork of a session there answers.
	sideReply?: unknown[];
	secretsDir?: string;
}

const startHost = ({
	version = 'test',
	runCrew,
	worktrees,
	attachmentsDir,
	commands = [],
	sideReply = [],
	secretsDir,
}: HostOptions = {}) => {
	const fake = createFakeQuery({ askOn: '[ask]', commands, sideReply });
	const registryFile = join(mkdtempSync(join(tmpdir(), 'voiceos-remote-')), 'sessions.json');
	let manager: SessionManager | null = null;
	let isBusyThere = false;
	const host = new RemoteHost({
		version,
		host: 'vm1',
		createManager: ({ readSession, emit, sendSecret }) => {
			manager = new SessionManager({
				readSession,
				emit,
				registryFile,
				home: '/h',
				fetchOrientation: async () => '',
				runQuery: fake.runQuery,
				onSecret: sendSecret,
				...(attachmentsDir ? { attachmentsDir } : {}),
				...(secretsDir ? { secretsDir } : {}),
			});

			return manager;
		},
		listWorktrees: async () => worktrees ?? [worktree('store/main')],
		runCrew: runCrew ?? (async () => ({ code: 0, stdout: '', stderr: '' })),
		readGitHead: async () => 'abc123',
		readMedia: () => null,
		...(secretsDir
			? {
					writeSecret: (copy: SecretCopy) =>
						writeSecretFile({ dir: secretsDir, ref: copy.toRef, ...copy }),
				}
			: {}),
		restoreHistory: async () => undefined,
		onBusyChanged: (isBusy) => {
			isBusyThere = isBusy;
		},
	});

	stops.push(() => host.stopAll());

	// Answers an ask there, as if the developer were at that machine.
	const answerThere = (askId: string): void => {
		manager?.permissions.answer(askId, { behavior: 'allow', updatedInput: {} });
	};

	return { host, fake, answerThere, isBusyThere: () => isBusyThere };
};

interface MainOptions {
	open: ReturnType<typeof createNetwork>['open'];
	runId?: string;
	mainId?: string;
	retryMs?: number;
	version?: string;
	updateRemote?: UpdateRemote;
	// The active set saved by an earlier run, loaded at boot as app.ts does.
	active?: string[];
	readAttachment?: (id: string) => Buffer | null;
	// A secret read on a machine, for an asker anywhere (cockpit-machines' deliverSecret).
	receiveSecret?: (copy: SecretCopy) => void;
	localWorktrees?: WorktreeInfo[];
}

const startMain = ({
	open,
	runId = 'run-1',
	mainId = 'main-1',
	retryMs = 0,
	version = 'test',
	updateRemote = async () => {
		throw new Error('no update expected');
	},
	active = [],
	readAttachment,
	receiveSecret,
	localWorktrees = [],
}: MainOptions) => {
	const store = new Store();
	const said: string[] = [];
	// Every turn the narrator is asked to report, quietly or aloud: a double report shows here.
	const narrated: string[] = [];
	const links = new MachineLinks({
		version,
		mainId,
		runId,
		open,
		updateRemote,
		setup: createSetupWorktree('/h'),
		getState: () => store.state,
		dispatch: (input) => store.dispatch(input),
		storeMedia: () => true,
		...(readAttachment ? { readAttachment } : {}),
		...(receiveSecret ? { receiveSecret } : {}),
		say: (text) => said.push(text),
		runLocalCrew: async () => ({ code: 0, stdout: '', stderr: '' }),
		handleLocal: () => undefined,
		retryMs,
	});

	store.onEffect(links.route);
	store.onEffect((effect) => {
		if (effect.type === 'speak') {
			said.push(effect.text);
		}

		if (effect.type === 'narrate') {
			narrated.push(effect.ref);
		}
	});
	store.subscribe(() => queueMicrotask(() => links.sync()));
	store.dispatch({ type: 'machines', machines: [VM1] });
	store.dispatch({ type: 'active_loaded', refs: active });
	links.setLocalWorktrees(localWorktrees);
	stops.push(() => links.stopAll());

	return { store, said, narrated, links };
};

const isConnected = (store: Store): boolean => store.state.machines.vm1?.status === 'connected';

// Acts once, as soon as the machine is connected: what it sends must arrive however the link fails
// after, so the scenario never repeats an action to paper over a lost one.
const actWhenConnected = async (store: Store, act: () => void, label: string): Promise<void> => {
	await until(() => isConnected(store), `${label}: connected`);
	act();
};

// Start, send A (it asks permission mid-turn) and B behind it, allow, both turns end.
const runScenario = async (store: Store): Promise<void> => {
	await actWhenConnected(store, () => store.dispatch({ type: 'activate', ref: REF }), 'start');
	await until(() => store.state.sessions[REF]?.status === 'idle', 'idle');
	// B queues behind A while A runs (words sent once A waits on its ask would answer the ask).
	store.dispatch({ type: 'send', ref: REF, text: '[ask] do A' });
	store.dispatch({ type: 'send', ref: REF, text: 'do B' });
	await until(() => store.state.asks.length === 1, 'the ask');
	await actWhenConnected(
		store,
		() => {
			const ask = store.state.asks[0];

			if (ask) {
				store.dispatch({ type: 'answer_permission', askId: ask.id, decision: 'allow' });
			}
		},
		'the answer',
	);
	await until(() => {
		const session = store.state.sessions[REF];

		return (
			store.state.asks.length === 0 &&
			session?.status === 'idle' &&
			session.queue.length === 0 &&
			session.stream.some((item) => item.kind === 'user' && item.text === 'do B')
		);
	}, 'both turns');
};

const sentTexts = (sent: string[]): string[] =>
	sent
		.filter((text) => text.includes('do A') || text.includes('do B'))
		.map((text) => (text.includes('do A') ? 'A' : 'B'));

// What the main shows of the session, without what legitimately differs after a drop (the
// reconnect notice, ids, times).
const readShown = (store: Store) => {
	const session = store.state.sessions[REF];

	return {
		status: session?.status,
		queue: session?.queue.length,
		said: session?.stream.flatMap((item) => (item.kind === 'user' ? [item.text] : [])),
		asks: store.state.asks.length,
	};
};

describe('a remote over a link', () => {
	it('start, ask, queue, allow → both messages delivered once, in order, the ask allowed once', async () => {
		const { host, fake } = startHost();

		await host.refreshWorktrees();

		const { store, said, narrated } = startMain({ open: createNetwork(host).open });

		await runScenario(store);
		await until(() => sentTexts(fake.sent).length === 2, 'B delivered');

		expect(sentTexts(fake.sent)).toEqual(['A', 'B']);
		expect(fake.decisions).toEqual(['allow']);
		expect(readShown(store)).toEqual({
			status: 'idle',
			queue: 0,
			said: ['[ask] do A', 'do B'],
			asks: 0,
		});
		expect(narrated).toEqual([REF, REF]);
		expect(said.filter((line) => line.includes('is back'))).toEqual([]);
	});

	it('a remote session is known on the main by its prefixed ref, labelled as there', async () => {
		const { host } = startHost();

		await host.refreshWorktrees();

		const { store } = startMain({ open: createNetwork(host).open });

		await until(() => isConnected(store), 'connected');

		expect(store.state.sessions[REF]).toMatchObject({ ref: REF, label: 'store/main' });
	});

	it('a second main → refused: the machine is held', async () => {
		const { host } = startHost();

		await host.refreshWorktrees();

		const network = createNetwork(host, { isHalfOpen: true });
		const first = startMain({ open: network.open });

		await until(() => isConnected(first.store), 'first connected');

		const other = startMain({ open: network.open, mainId: 'another-main', retryMs: 60_000 });

		await until(() => other.store.state.machines.vm1?.status === 'error', 'refused');

		expect(other.store.state.machines.vm1?.detail).toBe('Another Voice OS drives this machine.');
		expect(isConnected(first.store)).toBe(true);
	});

	it('another release there → the card says which versions and what to do', async () => {
		const { host } = startHost({ version: 'older' });

		await host.refreshWorktrees();

		const { store } = startMain({ open: createNetwork(host).open, retryMs: 60_000 });

		await until(() => store.state.machines.vm1?.status === 'error', 'refused');

		expect(store.state.machines.vm1?.detail).toBe(
			'This machine runs Voice OS older and the main test: run crew update on the older one, then crew server remote there.',
		);
	});

	describe('a remote on an older release', () => {
		// The main reaches whichever host is current: an update swaps the old one for a new one.
		const startSwappable = async (version: string) => {
			const { host } = startHost({ version });

			await host.refreshWorktrees();

			let network = createNetwork(host);
			const open: OpenTransport = (target, handlers) => network.open(target, handlers);

			const swapTo = async (next: string) => {
				const updated = startHost({ version: next }).host;

				await updated.refreshWorktrees();
				network = createNetwork(updated);
			};

			return { open, swapTo };
		};

		it('behind the main → updated there once, then connected on the new release', async () => {
			const { open, swapTo } = await startSwappable('5.0.1');
			const updated: string[] = [];
			const { store } = startMain({
				open,
				version: '5.1.0',
				retryMs: 60_000,
				updateRemote: async (host) => {
					updated.push(host);
					await swapTo('5.1.0');

					return { code: 0, output: '', isTimedOut: false };
				},
			});

			await until(() => isConnected(store), 'connected after the update');

			expect(updated).toEqual(['vm1']);
		});

		it('while the update runs → the card says so', async () => {
			const { open } = await startSwappable('5.0.1');
			let finish = (): void => undefined;
			const { store } = startMain({
				open,
				version: '5.1.0',
				retryMs: 60_000,
				updateRemote: () =>
					new Promise((resolve) => {
						finish = () => resolve({ code: 0, output: '', isTimedOut: false });
					}),
			});

			await until(() => store.state.machines.vm1?.detail !== null, 'the update started');

			expect(store.state.machines.vm1).toMatchObject({
				status: 'connecting',
				detail: 'Updating Build box…',
			});
			finish();
		});

		it('updated, but still on the old release → never updated again, told to restart it there', async () => {
			const { open } = await startSwappable('5.0.1');
			let updates = 0;
			const { store } = startMain({
				open,
				version: '5.1.0',
				retryMs: 60_000,
				updateRemote: async () => {
					updates++;

					return { code: 0, output: '', isTimedOut: false };
				},
			});

			await until(
				() => store.state.machines.vm1?.detail?.includes('is updated') === true,
				'waiting for its sessions',
			);

			expect(updates).toBe(1);
			expect(store.state.machines.vm1?.detail).toBe(
				'Build box is updated but still runs its old release: run crew server remote there.',
			);
		});

		it("the update fails → crew's own last line on the card, and no second try", async () => {
			const { open } = await startSwappable('5.0.1');
			let updates = 0;
			const { store } = startMain({
				open,
				version: '5.1.0',
				retryMs: 60_000,
				updateRemote: async () => {
					updates++;

					return {
						code: 1,
						output: 'Downloading…\nError: no release for linux/riscv64\n',
						isTimedOut: false,
					};
				},
			});

			await until(() => store.state.machines.vm1?.status === 'error', 'the failure');

			expect(updates).toBe(1);
			expect(store.state.machines.vm1?.detail).toBe(
				'Could not update Build box: Error: no release for linux/riscv64. Run crew update there, then crew server remote.',
			);
		});

		it('the machine removed while its update runs → no reconnect after it', async () => {
			const { open } = await startSwappable('5.0.1');
			let opens = 0;
			let finish = (): void => undefined;
			const { store } = startMain({
				open: (target, handlers) => {
					opens++;

					return open(target, handlers);
				},
				version: '5.1.0',
				retryMs: 60_000,
				updateRemote: () =>
					new Promise((resolve) => {
						finish = () => resolve({ code: 0, output: '', isTimedOut: false });
					}),
			});

			await until(() => store.state.machines.vm1?.detail === 'Updating Build box…', 'updating');
			store.dispatch({ type: 'machines', machines: [] });
			await until(() => store.state.machines.vm1 === undefined, 'removed');
			finish();
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(opens).toBe(1);
		});

		it('the update cannot even start → the failure on the card', async () => {
			const { open } = await startSwappable('5.0.1');
			const { store } = startMain({
				open,
				version: '5.1.0',
				retryMs: 60_000,
				updateRemote: async () => {
					throw new Error('spawn ssh ENOENT');
				},
			});

			await until(() => store.state.machines.vm1?.status === 'error', 'the failure');

			expect(store.state.machines.vm1?.detail).toBe(
				'Could not update Build box: Error: spawn ssh ENOENT. Run crew update there, then crew server remote.',
			);
		});

		it('newer than the main → nothing installed there; the card says to update this machine', async () => {
			const { open } = await startSwappable('5.2.0');
			const { store } = startMain({ open, version: '5.1.0', retryMs: 60_000 });

			await until(() => store.state.machines.vm1?.status === 'error', 'refused');

			expect(store.state.machines.vm1?.detail).toBe(
				'Build box runs Voice OS 5.2.0, newer than this one (5.1.0): run crew update here, then crew server restart.',
			);
		});
	});

	it('a restarted main → finds the open ask in the snapshot and can answer it', async () => {
		const { host, fake } = startHost();

		await host.refreshWorktrees();

		const network = createNetwork(host);
		const first = startMain({ open: network.open });

		await until(() => isConnected(first.store), 'connected');
		first.store.dispatch({ type: 'activate', ref: REF });
		await until(() => first.store.state.sessions[REF]?.status === 'idle', 'idle');
		first.store.dispatch({ type: 'send', ref: REF, text: '[ask] do A' });
		await until(() => first.store.state.asks.length === 1, 'the ask');
		first.links.stopAll();

		// The active set outlives the restart: the session asking there is still active.
		const second = startMain({ open: network.open, runId: 'run-2', active: [REF] });

		await until(() => second.store.state.asks.length === 1, 'the ask again');
		expect(second.store.state.sessions[REF]?.status).toBe('blocked');

		const ask = second.store.state.asks[0];

		second.store.dispatch({ type: 'answer_permission', askId: ask?.id ?? '', decision: 'allow' });
		await until(() => fake.decisions.length === 1, 'answered');

		expect(fake.decisions).toEqual(['allow']);
	});

	it('crew over the link → its answer; a call in flight when the link drops → rejected', async () => {
		const calls: string[][] = [];
		const held = Promise.withResolvers<CrewRunResult>();
		const { host } = startHost({
			runCrew: (args) => {
				calls.push(args);

				return args[1] === 'check'
					? held.promise
					: Promise.resolve({ code: 0, stdout: '[]', stderr: '' });
			},
		});

		await host.refreshWorktrees();

		const { store, links } = startMain({ open: createNetwork(host).open, retryMs: 60_000 });

		await until(() => isConnected(store), 'connected');

		const link = links.get('vm1');

		expect(await link?.runCrew(['dev', 'status', '--json'])).toEqual({
			code: 0,
			stdout: '[]',
			stderr: '',
		});

		const inFlight = link?.runCrew(['dev', 'check', 'store/main', '--json']);

		await until(() => calls.length === 2, 'the check reached the remote');
		link?.stop();

		await expect(inFlight).rejects.toThrow('went out of reach');
	});

	it("Set up's command over the link → run there from the typed command, its answer here", async () => {
		const calls: { args: string[]; stdin?: string; timeoutMs?: number }[] = [];
		const { host } = startHost({
			runCrew: async (args, options) => {
				calls.push({
					args,
					...(options?.stdin ? { stdin: options.stdin } : {}),
					...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
				});

				return { code: 0, stdout: '[]', stderr: '' };
			},
		});

		await host.refreshWorktrees();

		const { store, links } = startMain({ open: createNetwork(host).open });

		await until(() => isConnected(store), 'connected');

		expect(
			await links.get('vm1')?.runCommand({ type: 'import_plan', bundle: '{"version":2}' }),
		).toEqual({ code: 0, stdout: '[]', stderr: '' });
		// A ten-minute clone keeps its ten minutes there, past what the wire carries for old remotes.
		await links.get('vm1')?.runCommand({ type: 'add_worktree', ref: 'store/wrk2' });
		expect(calls).toEqual([
			{ args: ['import', '-', '--plan', '--json'], stdin: '{"version":2}', timeoutMs: 120_000 },
			{ args: ['add', 'worktree', 'store/wrk2', '--json'], timeoutMs: 600_000 },
		]);
	});

	it("crew killed for its timeout there → the page's 'timeout', never an answer", async () => {
		const { host } = startHost({
			runCrew: async () => ({ code: 143, stdout: '', stderr: '', timedOut: true }),
		});

		await host.refreshWorktrees();

		const { store, links } = startMain({ open: createNetwork(host).open });

		await until(() => isConnected(store), 'connected');

		const run = createSetupRunner({
			runLocal: async () => {
				throw new Error('must run there');
			},
			startLocal: () => undefined,
			getLink: (machine) => links.get(machine),
		});

		expect(await run('vm1', { type: 'add_worktree', ref: 'store/wrk2' })).toEqual({
			kind: 'failed',
			reason: 'timeout',
			error: 'crew did not finish in 600 s',
		});
	});

	it('a remote too old for typed commands → "remote_outdated" with its version, for the page', async () => {
		const { host } = startHost({ version: 'test' });

		await host.refreshWorktrees();

		// An older release's call schema strips the field it does not know, then judges args alone;
		// a timeout past its 5-minute cap fails that schema, and it drops the whole line.
		const older = {
			connect: (connection: Parameters<RemoteHost['connect']>[0]) => {
				const end = host.connect(connection);

				return {
					...end,
					receive: (line: string) => {
						const message = JSON.parse(line) as Record<string, unknown>;

						if (message.type === 'call') {
							delete message.command;

							if (Number(message.timeoutMs) > 300_000) {
								return;
							}
						}

						end.receive(JSON.stringify(message));
					},
				};
			},
		} as unknown as RemoteHost;
		const { store, links } = startMain({ open: createNetwork(older).open });

		await until(() => isConnected(store), 'connected');

		const failure = await links
			.get('vm1')
			?.runCommand({ type: 'rm_worktree', ref: 'store/wrk1', confirm: true })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CallFailure);
		expect(failure).toMatchObject({ reason: 'remote_outdated', version: 'test' });
		expect((failure as Error).message).toContain('it updates from this Mac');

		// A ten-minute command is refused as fast: the wire timeout stays inside the old schema.
		const startedAt = Date.now();

		await expect(
			links.get('vm1')?.runCommand({ type: 'add_worktree', ref: 'store/wrk2' }),
		).rejects.toMatchObject({ reason: 'remote_outdated' });
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	it('its setup session (isPinned on the wire, as every release sends it) → runs there for Set up, never active', async () => {
		const { host } = startHost({
			worktrees: [{ ...worktree('setup'), isPinned: true }, worktree('store/main')],
		});

		await host.refreshWorktrees();

		const { store } = startMain({ open: createNetwork(host).open, active: [REF, 'vm1:setup'] });

		await until(() => isConnected(store), 'connected');
		await until(() => store.state.sessions['vm1:setup']?.status === 'idle', 'setup started there');

		expect(store.state.sessions['vm1:setup']?.isPinned).toBe(true);
		expect(store.state.active).toEqual([REF]);
		expect(isActive(store.state, 'vm1:setup')).toBe(false);
	});

	it('not connected → "offline" at once, nothing written', async () => {
		const { host } = startHost();
		const { links } = startMain({
			open: createNetwork(host, { cutAfter: 0 }).open,
			retryMs: 60_000,
		});

		await until(() => links.get('vm1') !== undefined, 'link started');
		await expect(links.get('vm1')?.runCommand({ type: 'ls_projects' })).rejects.toMatchObject({
			reason: 'offline',
		});
	});

	it('a login banner run into the hello → the hello is still read', async () => {
		const { host } = startHost();

		await host.refreshWorktrees();

		const network = createNetwork(host);

		// The banner has no newline of its own, so it lands on the hello's line.
		const open: typeof network.open = (hostName, handlers) => {
			let isFirst = true;

			return network.open(hostName, {
				...handlers,
				onData: (chunk) => {
					handlers.onData(isFirst ? `Welcome to Ubuntu${String(chunk)}` : chunk);
					isFirst = false;
				},
			});
		};

		const { store } = startMain({ open });

		await until(() => isConnected(store), 'connected');
	});

	// The link cut after each frame in turn: whatever was in flight, the result is the same.
	const sweep = async (isHalfOpen: boolean): Promise<void> => {
		const clean = startHost();

		await clean.host.refreshWorktrees();

		const cleanNetwork = createNetwork(clean.host);
		const cleanMain = startMain({ open: cleanNetwork.open });

		await runScenario(cleanMain.store);

		const baseline = readShown(cleanMain.store);
		const total = cleanNetwork.frames();

		for (const stop of stops.splice(0)) {
			stop();
		}

		for (let cutAfter = 1; cutAfter <= total; cutAfter++) {
			const { host, fake } = startHost();

			await host.refreshWorktrees();

			let main: ReturnType<typeof startMain> | null = null;
			const network = createNetwork(host, {
				cutAfter,
				isHalfOpen,
				seed: cutAfter,
			});

			main = startMain({ open: network.open });

			const { store, said, narrated } = main;

			try {
				await runScenario(store);
				await until(() => sentTexts(fake.sent).length >= 2, 'B delivered');
			} catch (error) {
				throw new Error(
					`cut after frame ${cutAfter} (${network.log().join(', ')}): ${String(error)}`,
				);
			}

			const recaps = said.filter((line) => line.includes('is back')).length;

			expect({ cutAfter, cuts: network.cuts() }).toEqual({ cutAfter, cuts: 1 });
			expect({ cutAfter, sent: sentTexts(fake.sent) }).toEqual({ cutAfter, sent: ['A', 'B'] });
			expect({ cutAfter, decisions: fake.decisions }).toEqual({ cutAfter, decisions: ['allow'] });
			expect({ cutAfter, shown: readShown(store) }).toEqual({ cutAfter, shown: baseline });
			expect({ cutAfter, narrated }).toEqual({ cutAfter, narrated: [REF, REF] });
			// A reconnect is said only with news (a turn finished, or something new waits): at most once.
			expect(recaps <= 1, `cut after frame ${cutAfter}: ${recaps} recaps`).toBe(true);

			for (const stop of stops.splice(0)) {
				stop();
			}
		}
	};

	it('cut after any frame → the same outcome as no cut', async () => {
		await sweep(false);
	}, 60_000);

	it('cut after any frame, the host left half open → the same main takes its link back', async () => {
		await sweep(true);
	}, 60_000);
});

describe('the recap when a machine comes back', () => {
	const WAITING = 'Build box is back: store/main is waiting on you.';

	// A connected main with the session idle there, and a cut that can hold the link down while
	// something happens on the far side.
	const startConnected = async () => {
		const there = startHost();

		await there.host.refreshWorktrees();

		const network = createNetwork(there.host);
		let opens = 0;
		let isDown = false;

		const open: OpenTransport = (target, handlers) => {
			opens++;

			if (isDown) {
				setTimeout(() => handlers.onExit(255, ''), 0);

				return { write: () => undefined, close: () => undefined };
			}

			return network.open(target, handlers);
		};

		const main = startMain({ open });

		await until(() => isConnected(main.store), 'connected');
		main.store.dispatch({ type: 'activate', ref: REF });
		await until(() => main.store.state.sessions[REF]?.status === 'idle', 'idle');

		// Cuts the link; what `whileDown` does happens before the link can come back.
		const cut = async (whileDown?: () => Promise<void>): Promise<void> => {
			const before = opens;

			isDown = whileDown !== undefined;
			network.cut();
			await until(() => opens > before, 'a reconnect attempt');

			if (whileDown) {
				await whileDown();
				isDown = false;
			}

			await until(() => isConnected(main.store), 'back');
		};

		const recaps = (): string[] => main.said.filter((line) => line.includes('is back'));

		const ask = async (): Promise<void> => {
			main.store.dispatch({ type: 'send', ref: REF, text: '[ask] do A' });
			await until(() => main.store.state.asks.length === 1, 'the ask');
		};

		return { ...there, ...main, network, cut, recaps, ask };
	};

	it('idle there, cut and back → nothing said', async () => {
		const { cut, recaps } = await startConnected();

		await cut();

		expect(recaps()).toEqual([]);
	});

	it('an ask open, cut and back → said once that it waits', async () => {
		const { cut, recaps, ask } = await startConnected();

		await ask();
		await cut();

		expect(recaps()).toEqual([WAITING]);
	});

	it('an ask open, the session deactivated while cut → its wait not recapped; it is stopped', async () => {
		const { cut, recaps, ask, store } = await startConnected();

		await ask();
		await cut(async () => {
			store.dispatch({ type: 'deactivate', ref: REF });
		});

		expect(recaps()).toEqual([]);
		expect(store.state.asks).toEqual([]);
		expect(store.state.sessions[REF]?.status).toBe('stopped');
	});

	it('cut again with the same ask still open → not said again', async () => {
		const { cut, recaps, ask, network } = await startConnected();

		await ask();
		await cut();
		await cut();

		expect(network.cuts()).toBe(2);
		expect(recaps()).toEqual([WAITING]);
	});

	it('a turn finishing while cut → said once that it finished', async () => {
		const { cut, recaps, ask, store, answerThere, isBusyThere } = await startConnected();

		await ask();

		const askId = store.state.asks[0]?.id.replace(/^vm1:/, '') ?? '';

		await cut(async () => {
			answerThere(askId);
			await until(() => !isBusyThere(), 'the turn ended there');
		});

		expect(recaps()).toEqual(['Build box is back: store/main finished.']);
		expect(store.state.asks).toEqual([]);
	});

	it('the wait cleared, then the same session waits again after a later cut → said again', async () => {
		const { cut, recaps, ask, store, fake } = await startConnected();

		await ask();
		await cut();
		store.dispatch({
			type: 'answer_permission',
			askId: store.state.asks[0]?.id ?? '',
			decision: 'allow',
		});
		await until(
			() => store.state.asks.length === 0 && store.state.sessions[REF]?.status === 'idle',
			'answered',
		);
		await cut();
		await ask();
		await cut();

		expect(fake.decisions).toEqual(['allow']);
		expect(recaps()).toEqual([WAITING, WAITING]);
	});
});

describe('a line from the remote that does not parse', () => {
	it('→ dropped; the link stays up and still answers', async () => {
		const { host } = startHost({
			runCrew: async () => ({ code: 0, stdout: 'still here', stderr: '' }),
		});

		await host.refreshWorktrees();

		const network = createNetwork(host);
		let inject = (_text: string): void => undefined;

		const open: OpenTransport = (target, handlers) => {
			inject = (text) => handlers.onData(text);

			return network.open(target, handlers);
		};

		const { store, links } = startMain({ open, retryMs: 60_000 });

		await until(() => isConnected(store), 'connected');
		inject('not json at all\n{"type":"nonsense"}\n');

		expect(await links.get('vm1')?.runCrew(['dev', 'status', '--json'])).toMatchObject({
			stdout: 'still here',
		});
		expect(isConnected(store)).toBe(true);
	});
});

describe('files attached to a remote session', () => {
	const createFiles = () => {
		const root = mkdtempSync(join(tmpdir(), 'voiceos-remote-att-'));
		const mainDir = join(root, 'main');
		const thereDir = join(root, 'there');
		// Big enough for several pieces.
		const bytes = Buffer.from(Array.from({ length: 700_000 }, (_, index) => index % 253));
		const stored = storeAttachment({
			bytes,
			name: 'trace.bin',
			mediaType: 'application/octet-stream',
			dir: mainDir,
			mediaDir: join(root, 'media'),
		});

		if (!stored.ok) {
			throw new Error('not stored');
		}

		let reads = 0;

		const readAttachment = (id: string) => {
			reads++;

			return readAttachmentBytes(mainDir, id);
		};

		return { attachment: stored.attachment, bytes, thereDir, readAttachment, reads: () => reads };
	};

	const sendWithFile = async (cutAt?: (frames: number) => number) => {
		const files = createFiles();
		const { host, fake } = startHost({ attachmentsDir: files.thereDir });

		await host.refreshWorktrees();

		const network = createNetwork(host);
		const { store } = startMain({ open: network.open, readAttachment: files.readAttachment });

		await actWhenConnected(store, () => store.dispatch({ type: 'activate', ref: REF }), 'start');
		await until(() => store.state.sessions[REF]?.status === 'idle', 'idle');

		const before = network.frames();
		store.dispatch({ type: 'attachment_added', ref: REF, attachment: files.attachment });
		store.dispatch({ type: 'send', ref: REF, text: 'why does this fail?' });

		let wasSentAtCut = false;

		if (cutAt) {
			await until(() => network.frames() >= cutAt(before), 'mid-transfer');
			wasSentAtCut = fake.sent.some((text) => text.endsWith('why does this fail?'));
			network.cut();
		}

		await until(
			() => fake.sent.some((text) => text.endsWith('why does this fail?')),
			'the words there',
		);

		return { files, fake, store, network, wasSentAtCut };
	};

	it('the pieces go ahead of the words; Claude there reads the file at its own path', async () => {
		const { files, fake } = await sendWithFile();
		const path = join(files.thereDir, ...files.attachment.id.split('/'));

		expect(fake.sent.at(-1)).toBe(`${describeAttached([path])}\n\nwhy does this fail?`);
		expect(readAttachmentBytes(files.thereDir, files.attachment.id)?.equals(files.bytes)).toBe(
			true,
		);
	});

	it('the link cut mid-transfer → resent on the reconnect, the file whole, the words once', async () => {
		const { files, fake, network, wasSentAtCut } = await sendWithFile((before) => before + 2);

		expect(network.cuts()).toBe(1);
		expect(wasSentAtCut).toBe(false);

		expect(readAttachmentBytes(files.thereDir, files.attachment.id)?.equals(files.bytes)).toBe(
			true,
		);
		expect(fake.sent.filter((text) => text.endsWith('why does this fail?'))).toHaveLength(1);
	});

	it('the same file with later words → not sent across again', async () => {
		const { files, fake, store } = await sendWithFile();

		await until(() => store.state.sessions[REF]?.status === 'idle', 'idle again');
		store.dispatch({ type: 'attachment_added', ref: REF, attachment: files.attachment });
		store.dispatch({ type: 'send', ref: REF, text: 'and now?' });
		await until(() => fake.sent.some((text) => text.endsWith('and now?')), 'the second words');

		expect(files.reads()).toBe(1);
		expect(fake.sent.at(-1)).toContain(files.attachment.name);
	});

	it('a file gone from the main → the words still go, once, without it', async () => {
		const files = createFiles();
		const { host, fake } = startHost({ attachmentsDir: files.thereDir });

		await host.refreshWorktrees();

		const { store } = startMain({ open: createNetwork(host).open, readAttachment: () => null });

		await actWhenConnected(store, () => store.dispatch({ type: 'activate', ref: REF }), 'start');
		await until(() => store.state.sessions[REF]?.status === 'idle', 'idle');
		store.dispatch({ type: 'attachment_added', ref: REF, attachment: files.attachment });
		store.dispatch({ type: 'send', ref: REF, text: 'look' });
		await until(() => fake.sent.some((text) => text.endsWith('look')), 'the words there');

		expect(fake.sent.filter((text) => text.endsWith('look'))).toEqual(['look']);
		expect(readAttachmentBytes(files.thereDir, files.attachment.id)).toBeNull();
	});

	describe("a remote session's slash commands", () => {
		it('its commands reach the main; a reload typed on the main runs there and is said here', async () => {
			const REVIEW = { name: 'review', description: 'Review a change', argumentHint: '<pr>' };
			const { host, fake } = startHost({ commands: [REVIEW] });

			await host.refreshWorktrees();

			const { store } = startMain({ open: createNetwork(host).open });

			await actWhenConnected(store, () => store.dispatch({ type: 'activate', ref: REF }), 'start');
			await until(() => store.state.sessions[REF]?.commands?.length === 1, 'the commands');
			store.dispatch({ type: 'reload_session', ref: REF, kind: 'plugins' });
			await until(
				() =>
					store.state.sessions[REF]?.stream.some(
						(item) => item.kind === 'notice' && item.text.startsWith('Plugins reloaded'),
					) ?? false,
				'the notice',
			);

			expect(store.state.sessions[REF]?.commands).toEqual([REVIEW]);
			expect(fake.reloads).toEqual(['plugins:hold']);
		});

		it("a restarted main → the running session's newest commands come back in the snapshot", async () => {
			const REVIEW = { name: 'review', description: 'Review a change', argumentHint: '<pr>' };
			const SHIP = { name: 'ship', description: 'Ship it', argumentHint: '' };
			const { host, fake } = startHost({ commands: [REVIEW] });

			await host.refreshWorktrees();

			const network = createNetwork(host);
			const first = startMain({ open: network.open });

			await actWhenConnected(
				first.store,
				() => first.store.dispatch({ type: 'activate', ref: REF }),
				'start',
			);
			await until(() => first.store.state.sessions[REF]?.commands?.length === 1, 'the commands');
			first.links.stopAll();
			// Pushed while no main listens: only the snapshot can carry it.
			fake.pushCommands([REVIEW, SHIP]);

			const second = startMain({ open: network.open, runId: 'run-2', active: [REF] });

			await until(
				() => second.store.state.sessions[REF]?.commands?.length === 2,
				'the commands again',
			);
			expect(second.store.state.sessions[REF]?.commands).toEqual([REVIEW, SHIP]);
		});
	});
});

describe('sessions asking sessions across the link', () => {
	const ASKER = 'store-front/main';

	const setupBoth = (sideReply: unknown[] = []) => {
		const there = mkdtempSync(join(tmpdir(), 'voiceos-peer-there-'));
		const here = mkdtempSync(join(tmpdir(), 'voiceos-peer-here-'));
		const remote = startHost({
			sideReply,
			secretsDir: join(there, 'secrets'),
			worktrees: [{ ...worktree('store/main'), cwd: there }],
		});
		const network = createNetwork(remote.host);
		const delivered: SecretCopy[] = [];
		const main = startMain({
			open: network.open,
			localWorktrees: [worktree(ASKER)],
			receiveSecret: (copy) => {
				delivered.push(copy);

				const path = writeSecretFile({ dir: join(here, 'secrets'), ref: copy.toRef, ...copy });

				main.store.dispatch({ type: 'secret_transferred', ref: copy.toRef, id: copy.id, path });
			},
		});
		const seen: string[] = [];

		main.store.subscribe((stamped) => seen.push(JSON.stringify(stamped.input)));

		return { there, here, remote, main, delivered, seen };
	};

	const startBoth = async ({ main, remote }: ReturnType<typeof setupBoth>) => {
		await remote.host.refreshWorktrees();
		await actWhenConnected(
			main.store,
			() => main.store.dispatch({ type: 'activate', ref: REF }),
			'start',
		);
		await until(() => main.store.state.sessions[REF]?.status === 'idle', 'remote idle');
		main.store.dispatch({ type: 'activate', ref: ASKER });
		main.store.dispatch({ type: 'session_started', ref: ASKER });
	};

	it('a session here asks one there → the copy runs there, the answer comes back to the asker', async () => {
		const both = setupBoth([
			{ type: 'assistant', message: { content: [{ type: 'text', text: 'Five tries.' }] } },
			{ type: 'result', subtype: 'success' },
		]);

		await startBoth(both);
		both.main.store.dispatch({
			type: 'session_ask_requested',
			ref: ASKER,
			id: 'r1',
			kind: 'ask',
			session: REF,
			text: 'Which retry limit?',
			files: [],
		});
		await until(
			() =>
				both.main.store.state.sessions[ASKER]?.stream.some(
					(item) => item.kind === 'session_ask' && item.status === 'answered',
				) ?? false,
			'answered',
		);

		expect(both.remote.fake.forks).toHaveLength(1);
		expect(
			both.main.store.state.sessions[REF]?.stream.find((item) => item.kind === 'session_ask'),
		).toMatchObject({ role: 'asked', status: 'answered', answer: 'Five tries.' });
	});

	it('a secret there, allowed → copied to the asker here; its value never enters the state', async () => {
		const both = setupBoth();
		const logFile = join(both.here, 'voiceos.log');
		const effects: string[] = [];

		configureLog({ file: logFile, quiet: true });
		both.main.store.onEffect((effect) => {
			effects.push(JSON.stringify(effect));
		});
		writeFileSync(join(both.there, '.env'), 'STRIPE_KEY=sk_live_never_in_state\n');
		await startBoth(both);
		both.main.store.dispatch({
			type: 'session_ask_requested',
			ref: ASKER,
			id: 'r2',
			kind: 'secret',
			session: REF,
			text: 'STRIPE_KEY',
			files: [],
		});
		both.main.store.dispatch({ type: 'answer_peer', askId: 'r2:ok', isApproved: true });
		await until(() => both.delivered.length === 1, 'the copy');

		const last = both.main.store.state.sessions[ASKER]?.stream.at(-1);
		const path = join(both.here, 'secrets', 'store-front_main', 'r2', 'STRIPE_KEY.env');

		expect(both.delivered[0]?.toRef).toBe(ASKER);
		expect(readFileSync(path, 'utf8')).toBe('STRIPE_KEY=sk_live_never_in_state\n');
		expect(last).toMatchObject({ kind: 'user', from: 'store/main' });
		expect(both.seen.join('\n')).not.toContain('sk_live_never_in_state');
		expect(effects.join('\n')).not.toContain('sk_live_never_in_state');
		expect(readFileSync(logFile, 'utf8')).toContain('secret');
		expect(readFileSync(logFile, 'utf8')).not.toContain('sk_live_never_in_state');
		configureLog({ quiet: true });
	});
});
