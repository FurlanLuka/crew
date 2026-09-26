import { describe, expect, it } from 'bun:test';
import { configureLog } from '../log.js';
import { Store } from '../state/store.js';
import type { CheckRow, RouteRow } from './servers.js';
import { DevWatch, type DevCrew } from './watch.js';

configureLog({ quiet: true });

const REF = 'store-front/main';
const createRow = (server: string, patch: Partial<CheckRow> = {}): CheckRow => ({
	project: server,
	server,
	port: 3000,
	alive: true,
	listening: true,
	referenced: true,
	...patch,
});

interface SaidLine {
	text: string;
	priority: string;
	isAsking: boolean;
}

const createHarness = ({
	rows = [createRow('api'), createRow('web')],
	routes = [{ worktree: REF, server_name: 'api', url: 'http://localhost:3000' }] as RouteRow[],
} = {}) => {
	// crew as the watcher sees it: canned rows, routes and a fix prompt, recording every call.
	const store = new Store();

	store.dispatch({
		type: 'worktrees',
		worktrees: [{ ref: REF, label: REF, branch: 'main', cwd: '/w', dirs: [], isPinned: false }],
	});
	store.dispatch({ type: 'session_started', ref: REF });

	const calls: string[] = [];
	const said: SaidLine[] = [];
	const crew = {
		rows,
		routes,
		devFails: false,
		fixPromptFails: false,
		runDev: async (ref: string, action: string) => {
			calls.push(`dev ${action} ${ref}`);

			if (crew.devFails) {
				throw new Error('port in use');
			}

			return '';
		},
		checkServers: async (ref: string, { wait = false } = {}) => {
			calls.push(`check ${ref}${wait ? ' --wait' : ''}`);

			return crew.rows;
		},
		readDevRoutes: async () => crew.routes,
		readFixPrompt: async (ref: string) => {
			calls.push(`fix ${ref}`);

			if (crew.fixPromptFails) {
				throw new Error('timed out');
			}

			return `fix prompt for ${ref}`;
		},
	};
	const clock = { now: 1000 };
	const watch = new DevWatch({
		store,
		crew: crew as unknown as DevCrew,
		say: (line) => said.push({ text: line.text, priority: line.priority, isAsking: line.isAsking }),
		now: () => clock.now,
	});

	const start = async () => {
		store.dispatch({ type: 'dev_start', ref: REF });
		await watch.handle({ type: 'dev', ref: REF, action: 'start' });
	};

	return { store, crew, watch, calls, said, start, clock };
};

describe('DevWatch start', () => {
	it('nothing running → "starting", crew starts, waits for the verdict, then one line: all up', async () => {
		const harness = createHarness();
		await harness.start();
		expect(harness.calls).toEqual([`dev start ${REF}`, `check ${REF} --wait`]);
		expect(harness.said.map((line) => line.text)).toEqual([
			'starting dev servers.',
			'all two dev servers are up.',
		]);
		// Status lines ask nothing: a bare "yes" after them is not for this worktree.
		expect(harness.said.map((line) => line.isAsking)).toEqual([false, false]);
		expect(harness.store.state.devStarting).toEqual([]);
		expect(harness.store.state.devServers[REF]?.map((server) => server.state)).toEqual([
			'running',
			'running',
		]);
		expect(harness.store.state.devServers[REF]?.[0]?.url).toBe('http://localhost:3000');
	});

	it('a server dies during the start → named, with a fix offer', async () => {
		const harness = createHarness({ rows: [createRow('api', { alive: false }), createRow('web')] });
		await harness.start();
		expect(harness.said.at(-1)).toEqual({
			text: 'api died. Want Claude to fix it?',
			priority: 'high',
			isAsking: true,
		});
		expect(harness.store.state.devOffer).toEqual({ ref: REF, servers: ['api'], at: 1000 });
	});

	it('already running → "already up", crew not called', async () => {
		const harness = createHarness();
		harness.store.dispatch({
			type: 'dev_servers',
			ref: REF,
			servers: [{ name: 'api', port: 1, url: null, state: 'running', detail: null }],
			isSettled: false,
		});
		await harness.start();
		expect(harness.calls).toEqual([]);
		expect(harness.said.map((line) => line.text)).toEqual(['dev servers are already up.']);
		expect(harness.said[0]?.isAsking).toBe(false);
		expect(harness.store.state.devStarting).toEqual([]);
	});

	it('already failing → named with the fix offer, crew not called', async () => {
		const harness = createHarness();
		harness.store.dispatch({
			type: 'dev_servers',
			ref: REF,
			servers: [{ name: 'api', port: 1, url: null, state: 'died', detail: null }],
			isSettled: false,
		});
		await harness.start();
		expect(harness.calls).toEqual([]);
		expect(harness.said.at(-1)?.text).toBe('api is failing. Want Claude to fix it?');
		expect(harness.said.at(-1)?.isAsking).toBe(true);
		expect(harness.store.state.devOffer?.servers).toEqual(['api']);
	});

	it('crew cannot start them → said, and no longer marked starting', async () => {
		const harness = createHarness();
		harness.crew.devFails = true;
		await harness.start();
		expect(harness.said.at(-1)?.text).toContain('did not start');
		expect(harness.store.state.devStarting).toEqual([]);
	});
});

describe('DevWatch monitor', () => {
	it('a running server dies later → one announcement with the offer; the next look says nothing new', async () => {
		const harness = createHarness();
		await harness.watch.monitor();
		expect(harness.said).toEqual([]);
		harness.crew.rows = [createRow('api', { alive: false }), createRow('web')];
		await harness.watch.monitor();
		await harness.watch.monitor();
		expect(harness.said).toEqual([
			{ text: 'api went down. Want Claude to fix it?', priority: 'high', isAsking: true },
		]);
		expect(harness.store.state.devOffer?.servers).toEqual(['api']);
	});

	it('a poll that fires while the last look still runs → joins it: one announcement, one offer', async () => {
		const harness = createHarness();
		await harness.watch.monitor();
		const slow = Promise.withResolvers<void>();
		const check = harness.crew.checkServers;

		harness.crew.checkServers = async (...args: Parameters<typeof check>) => {
			await slow.promise;

			return check(...args);
		};

		harness.crew.rows = [createRow('api', { alive: false }), createRow('web')];
		const first = harness.watch.monitor();
		const second = harness.watch.monitor();
		slow.resolve();
		await Promise.all([first, second]);
		expect(harness.calls.filter((call) => call === `check ${REF}`)).toHaveLength(2);
		await harness.watch.monitor();
		expect(harness.said).toEqual([
			{ text: 'api went down. Want Claude to fix it?', priority: 'high', isAsking: true },
		]);
	});

	it('servers down for one look only (a restart from a terminal) → never announced', async () => {
		const harness = createHarness();
		await harness.watch.monitor();
		harness.crew.rows = [createRow('api', { alive: false }), createRow('web', { alive: false })];
		await harness.watch.monitor();
		harness.crew.rows = [createRow('api'), createRow('web')];
		await harness.watch.monitor();
		await harness.watch.monitor();
		expect(harness.said).toEqual([]);
		expect(harness.store.state.devOffer).toBeNull();
	});

	it('a restarted server alive but not listening yet (slow boot) → quiet for a minute of looks, then announced', async () => {
		const harness = createHarness();
		await harness.watch.monitor();
		harness.crew.rows = [createRow('api', { listening: false }), createRow('web')];

		for (let i = 0; i < 6; i++) {
			await harness.watch.monitor();
			harness.clock.now += 10_000;
		}

		expect(harness.said).toEqual([]);
		await harness.watch.monitor();
		expect(harness.said).toEqual([
			{ text: 'api went down. Want Claude to fix it?', priority: 'high', isAsking: true },
		]);
	});

	it('servers stopped (the worktree left crew dev status) → cleared quietly', async () => {
		const harness = createHarness();
		await harness.watch.monitor();
		harness.crew.routes = [];
		await harness.watch.monitor();
		expect(harness.store.state.devServers).toEqual({});
		expect(harness.said).toEqual([]);
	});

	it('a start still being watched is left alone by the monitor', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'dev_start', ref: REF });
		await harness.watch.monitor();
		expect(harness.calls.filter((call) => call.startsWith('check'))).toEqual([]);
	});
});

describe('DevWatch fix', () => {
	it("crew's fix prompt → sent to that worktree's Claude; said who is on it", async () => {
		const harness = createHarness();
		await harness.watch.handle({ type: 'fix_dev', ref: REF, servers: ['api'] });
		const sent = harness.store.state.sessions[REF]?.stream.at(-1);
		expect(sent).toMatchObject({ kind: 'user', text: `fix prompt for ${REF}` });
		expect(harness.said.at(-1)?.text).toBe('fixing api: Claude is on it.');
	});

	it('no fix prompt in time → the evidence Voice OS has goes instead', async () => {
		const harness = createHarness();
		harness.crew.fixPromptFails = true;
		harness.store.dispatch({
			type: 'dev_servers',
			ref: REF,
			servers: [{ name: 'api', port: 3000, url: null, state: 'died', detail: 'exit 1' }],
			isSettled: false,
		});
		await harness.watch.handle({ type: 'fix_dev', ref: REF, servers: ['api'] });
		const sent = harness.store.state.sessions[REF]?.stream.at(-1);
		expect(sent?.kind === 'user' ? sent.text : '').toContain('- api (port 3000): died — exit 1');
	});

	it('a stopped session → said that its Claude is being started', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'stop_session', ref: REF });
		await harness.watch.handle({ type: 'fix_dev', ref: REF, servers: ['api'] });
		expect(harness.said.at(-1)?.text).toBe('fixing api: starting its Claude to fix it.');
	});
});
