import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrewRunResult } from '../crew/adapter.js';
import { configureLog } from '../log.js';
import { SessionManager } from '../sessions/manager.js';
import { createSetupWorktree } from '../sessions/setup-session.js';
import { Store } from '../state/store.js';
import { createFakeQuery } from '../../test/support/fake-query.js';
import { createNetwork, until } from '../../test/support/link.js';
import { worktree } from '../../test/support/reduce.js';
import { RemoteHost } from './host.js';
import { MachineLinks } from './links.js';
import type { OpenTransport } from './link.js';
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
	runCrew?: (args: string[]) => Promise<CrewRunResult>;
}

const startHost = ({ version = 'test', runCrew }: HostOptions = {}) => {
	const fake = createFakeQuery({ askOn: '[ask]' });
	const registryFile = join(mkdtempSync(join(tmpdir(), 'voiceos-remote-')), 'sessions.json');
	const host = new RemoteHost({
		version,
		host: 'vm1',
		createManager: ({ readSession, emit }) =>
			new SessionManager({
				readSession,
				emit,
				registryFile,
				home: '/h',
				fetchOrientation: async () => '',
				runQuery: fake.runQuery,
			}),
		listWorktrees: async () => [worktree('store/main')],
		runCrew: runCrew ?? (async () => ({ code: 0, stdout: '', stderr: '' })),
		readGitHead: async () => 'abc123',
		readMedia: () => null,
		restoreHistory: async () => undefined,
	});

	stops.push(() => host.stopAll());

	return { host, fake };
};

interface MainOptions {
	open: ReturnType<typeof createNetwork>['open'];
	runId?: string;
	mainId?: string;
	retryMs?: number;
	version?: string;
	updateRemote?: UpdateRemote;
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
		say: (text) => said.push(text),
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
	links.setLocalWorktrees([]);
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
	await actWhenConnected(store, () => store.dispatch({ type: 'start_session', ref: REF }), 'start');
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
			'This machine runs Voice OS older and the main test: run crew update on the older one, then crew voice remote there.',
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

					return { code: 0, output: '' };
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
						finish = () => resolve({ code: 0, output: '' });
					}),
			});

			await until(() => store.state.machines.vm1?.detail !== null, 'the update started');

			expect(store.state.machines.vm1).toMatchObject({
				status: 'connecting',
				detail: 'Updating Build box to 5.1.0…',
			});
			finish();
		});

		it('updated, but its sessions keep the old release running → waited for, never updated again', async () => {
			const { open } = await startSwappable('5.0.1');
			let updates = 0;
			const { store } = startMain({
				open,
				version: '5.1.0',
				retryMs: 60_000,
				updateRemote: async () => {
					updates++;

					return { code: 0, output: '' };
				},
			});

			await until(
				() => store.state.machines.vm1?.detail?.includes('switches to 5.1.0') === true,
				'waiting for its sessions',
			);

			expect(updates).toBe(1);
			expect(store.state.machines.vm1?.detail).toBe(
				'Build box is updated; it switches to 5.1.0 once its sessions finish their work.',
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

					return { code: 1, output: 'Downloading…\nError: no release for linux/riscv64\n' };
				},
			});

			await until(() => store.state.machines.vm1?.status === 'error', 'the failure');

			expect(updates).toBe(1);
			expect(store.state.machines.vm1?.detail).toBe(
				'Could not update Build box: Error: no release for linux/riscv64. Run crew update there, then crew voice remote.',
			);
		});

		it('newer than the main → nothing installed there; the card says to update this machine', async () => {
			const { open } = await startSwappable('5.2.0');
			const { store } = startMain({ open, version: '5.1.0', retryMs: 60_000 });

			await until(() => store.state.machines.vm1?.status === 'error', 'refused');

			expect(store.state.machines.vm1?.detail).toBe(
				'Build box runs Voice OS 5.2.0, newer than this one (5.1.0): run crew update here, then crew voice restart.',
			);
		});
	});

	it('a restarted main → finds the open ask in the snapshot and can answer it', async () => {
		const { host, fake } = startHost();

		await host.refreshWorktrees();

		const network = createNetwork(host);
		const first = startMain({ open: network.open });

		await until(() => isConnected(first.store), 'connected');
		first.store.dispatch({ type: 'start_session', ref: REF });
		await until(() => first.store.state.sessions[REF]?.status === 'idle', 'idle');
		first.store.dispatch({ type: 'send', ref: REF, text: '[ask] do A' });
		await until(() => first.store.state.asks.length === 1, 'the ask');
		first.links.stopAll();

		const second = startMain({ open: network.open, runId: 'run-2' });

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

			let wasConnected = false;
			let main: ReturnType<typeof startMain> | null = null;
			const network = createNetwork(host, {
				cutAfter,
				isHalfOpen,
				seed: cutAfter,
				onCut: () => {
					wasConnected = main ? isConnected(main.store) : false;
				},
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
			// Back after being connected → one recap; a cut before the first hello may or may not
			// have something to tell.
			expect({ cutAfter, recaps: wasConnected ? recaps : Math.min(recaps, 1) }).toEqual({
				cutAfter,
				recaps: wasConnected ? 1 : recaps,
			});

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
