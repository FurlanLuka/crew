import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import type { Machine, MachineStatus, State, View, WorktreeInfo } from '../shared/protocol.js';
import { createInitialState, createSession, type Effect } from '../state/reducer.js';
import { Store } from '../state/store.js';
import {
	RESTART_ANNOUNCE_MS,
	VIEW_RESTORE_MS,
	loadView,
	migrateSavedView,
	persistView,
	restoredView,
	shouldAnnounceRestart,
} from './view.js';

configureLog({ quiet: true });

const worktree = (ref: string): WorktreeInfo => ({
	ref,
	label: ref,
	branch: '',
	cwd: '/w',
	dirs: [],
	isPinned: false,
});

const vm1 = (status: MachineStatus): Machine => ({
	id: 'vm1',
	host: 'vm1',
	name: 'build box',
	status,
	detail: null,
	since: 0,
});

const withState = (refs: string[], machines: Record<string, Machine> = {}): State => ({
	...createInitialState(),
	sessions: Object.fromEntries(refs.map((ref) => [ref, createSession(worktree(ref))])),
	order: refs,
	machines,
});

const createViewFile = (view?: View): string => {
	const file = join(mkdtempSync(join(tmpdir(), 'voiceos-view-')), 'view.json');

	if (view) {
		writeFileSync(file, JSON.stringify(view));
	}

	return file;
};

// The restore is dispatched after the input that allowed it has reached every listener.
const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

describe('restoredView', () => {
	const session = (ref: string): View => ({ kind: 'session', ref });

	it('a local session still there → applied', () => {
		expect(restoredView(session('store/main'), withState(['store/main']))).toEqual({
			kind: 'apply',
			view: session('store/main'),
		});
	});

	it("a local session gone → dropped at once: this Mac's worktrees are already read", () => {
		expect(restoredView(session('store/wrk9'), withState(['store/main']))).toEqual({
			kind: 'drop',
		});
	});

	it('a remote session, its machine still syncing → waits; once its worktrees arrive → applied', () => {
		const saved = session('vm1:store/main');

		expect(restoredView(saved, withState([], { vm1: vm1('syncing') }))).toEqual({ kind: 'wait' });
		expect(restoredView(saved, withState(['vm1:store/main'], { vm1: vm1('connected') }))).toEqual({
			kind: 'apply',
			view: saved,
		});
	});

	it('a remote session its connected machine no longer has → dropped', () => {
		expect(
			restoredView(session('vm1:store/wrk9'), withState([], { vm1: vm1('connected') })),
		).toEqual({ kind: 'drop' });
	});

	it('a remote machine still out of reach → waits until 60 s, then dropped', () => {
		const state = withState([], { vm1: vm1('unreachable') });

		expect(restoredView(session('vm1:store/main'), state, VIEW_RESTORE_MS - 1)).toEqual({
			kind: 'wait',
		});
		expect(restoredView(session('vm1:store/main'), state, VIEW_RESTORE_MS)).toEqual({
			kind: 'drop',
		});
	});

	it('a known session but 61 s waited → dropped: the developer has been looking elsewhere', () => {
		expect(restoredView(session('store/main'), withState(['store/main']), 61_000)).toEqual({
			kind: 'drop',
		});
	});

	it('Activate for every machine or this Mac, Settings → applied', () => {
		const state = withState([]);

		for (const view of [
			{ kind: 'activate' },
			{ kind: 'activate', machine: 'local' },
			{ kind: 'settings' },
		] satisfies View[]) {
			expect(restoredView(view, state)).toEqual({ kind: 'apply', view });
		}
	});

	it('Activate for a remote machine → applied while it is known; one not known → waits like its sessions, then dropped', () => {
		const saved: View = { kind: 'activate', machine: 'vm1' };

		expect(restoredView(saved, withState([], { vm1: vm1('syncing') }))).toEqual({
			kind: 'apply',
			view: saved,
		});
		expect(restoredView(saved, withState([]))).toEqual({ kind: 'wait' });
		expect(restoredView(saved, withState([]), VIEW_RESTORE_MS)).toEqual({ kind: 'drop' });
	});

	it('Active → applied at once and at the limit: it waits on no machine', () => {
		const state = withState([], { vm1: vm1('unreachable') });

		expect(restoredView({ kind: 'active' }, state)).toEqual({
			kind: 'apply',
			view: { kind: 'active' },
		});
		expect(restoredView({ kind: 'active' }, state, VIEW_RESTORE_MS)).toEqual({
			kind: 'apply',
			view: { kind: 'active' },
		});
	});

	it('a remote session opened from Active → waits like any session, keeping from', () => {
		const saved: View = { kind: 'session', ref: 'vm1:store/main', from: 'active' };

		expect(restoredView(saved, withState([], { vm1: vm1('syncing') }))).toEqual({ kind: 'wait' });
		expect(restoredView(saved, withState(['vm1:store/main'], { vm1: vm1('connected') }))).toEqual({
			kind: 'apply',
			view: saved,
		});
	});
});

describe('shouldAnnounceRestart', () => {
	const bootAt = 1_000_000;

	const announce = (patch: { now: number; isSaid?: boolean; hadSavedView?: boolean }): boolean =>
		shouldAnnounceRestart({ bootAt, isSaid: false, hadSavedView: true, ...patch });

	it('the first page after a restart → announced', () => {
		expect(announce({ now: bootAt + 5_000 })).toBe(true);
	});

	it('a second page → not again', () => {
		expect(announce({ now: bootAt + 6_000, isSaid: true })).toBe(false);
	});

	it('a page at 2:01 → opened fresh, nothing said', () => {
		expect(announce({ now: bootAt + RESTART_ANNOUNCE_MS + 1_000 })).toBe(false);
	});

	it('no saved view at boot (a first start) → nothing said', () => {
		expect(announce({ now: bootAt + 5_000, hadSavedView: false })).toBe(false);
	});
});

describe('persistView', () => {
	const bootStore = (refs: string[]): { store: Store; effects: Effect[] } => {
		const store = new Store();
		const effects: Effect[] = [];

		store.onEffect((effect) => void effects.push(effect));
		store.dispatch({ type: 'worktrees', worktrees: refs.map(worktree) });

		return { store, effects };
	};

	it('switch_view → view.json holds the view', () => {
		const file = createViewFile();
		const { store } = bootStore(['store/main']);

		persistView({ store, file });
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store/main' } });

		expect(loadView(file)).toEqual({ kind: 'session', ref: 'store/main' });
	});

	it('a held activation opened when crew lists its worktree → saved; a restart lands on it', async () => {
		const file = createViewFile();
		const { store } = bootStore(['store/main']);

		persistView({ store, file });
		store.dispatch({ type: 'activate', ref: 'store/wrk9', open: true });
		expect(loadView(file)).toBeNull();

		store.dispatch({
			type: 'worktrees',
			worktrees: [worktree('store/main'), worktree('store/wrk9')],
		});
		expect(store.state.view).toMatchObject({ kind: 'session', ref: 'store/wrk9' });
		expect(loadView(file)).toEqual(store.state.view);

		const restarted = bootStore(['store/main', 'store/wrk9']).store;

		restarted.dispatch({ type: 'active_loaded', refs: ['store/wrk9'] });
		persistView({ store: restarted, file });
		await flush();

		expect(restarted.state.view).toEqual(store.state.view);
	});

	it('boot with a saved session → restored silently, nothing said', async () => {
		const file = createViewFile({ kind: 'session', ref: 'store/main' });
		const { store, effects } = bootStore(['store/main']);

		persistView({ store, file });
		await flush();

		expect(store.state.view).toEqual({ kind: 'session', ref: 'store/main' });
		expect(store.state.focus).toBe('store/main');
		expect(effects.filter((effect) => effect.type === 'speak')).toEqual([]);
	});

	const bootWithRemote = (saved: View): Store => {
		const { store } = bootStore(['store/main']);

		store.dispatch({ type: 'machines', machines: [{ id: 'vm1', host: 'vm1', name: 'build box' }] });
		persistView({ store, file: createViewFile(saved) });

		return store;
	};

	const remoteArrives = (store: Store): void =>
		void store.dispatch({
			type: 'worktrees',
			worktrees: [worktree('store/main'), worktree('vm1:store/main')],
		});

	it('a remote session → waits for its machine; restored once its worktrees arrive', async () => {
		const store = bootWithRemote({ kind: 'session', ref: 'vm1:store/main' });

		await flush();
		expect(store.state.view).toEqual({ kind: 'active' });

		remoteArrives(store);
		await flush();
		expect(store.state.view).toEqual({ kind: 'session', ref: 'vm1:store/main' });
	});

	it('a remote machine unreachable for 60 s, then its worktrees arrive → the view stays', async () => {
		const { store } = bootStore(['store/main']);
		let clock = 0;

		store.dispatch({ type: 'machines', machines: [{ id: 'vm1', host: 'vm1', name: 'build box' }] });
		store.dispatch({ type: 'machine_status', id: 'vm1', status: 'unreachable' });
		persistView({
			store,
			file: createViewFile({ kind: 'session', ref: 'vm1:store/main' }),
			now: () => clock,
		});
		clock = VIEW_RESTORE_MS;
		store.dispatch({ type: 'worktrees', worktrees: [worktree('store/main')] });
		remoteArrives(store);
		await flush();

		expect(store.state.view).toEqual({ kind: 'active' });
	});

	it('boot with and without view.json → persistView says which', () => {
		expect(
			persistView({ store: bootStore([]).store, file: createViewFile({ kind: 'settings' }) }),
		).toBe(true);
		expect(persistView({ store: bootStore([]).store, file: createViewFile() })).toBe(false);
	});

	it('the developer switches before a remote view arrives → their view stays', async () => {
		const store = bootWithRemote({ kind: 'session', ref: 'vm1:store/main' });

		store.dispatch({ type: 'switch_view', view: { kind: 'settings' } });
		remoteArrives(store);
		await flush();

		expect(store.state.view).toEqual({ kind: 'settings' });
	});

	it('a session from Active, the set loaded → restored from Active once its machine is back', async () => {
		const { store } = bootStore(['store/main']);

		store.dispatch({ type: 'machines', machines: [{ id: 'vm1', host: 'vm1', name: 'build box' }] });
		store.dispatch({ type: 'active_loaded', refs: ['vm1:store/main'] });
		persistView({
			store,
			file: createViewFile({ kind: 'session', ref: 'vm1:store/main', from: 'active' }),
		});
		await flush();
		expect(store.state.view).toEqual({ kind: 'active' });

		remoteArrives(store);
		await flush();
		expect(store.state.view).toEqual({ kind: 'session', ref: 'vm1:store/main', from: 'active' });
	});

	it('Active and a session from Active → read back; any other from → nothing restored', () => {
		expect(loadView(createViewFile({ kind: 'active' }))).toEqual({ kind: 'active' });
		expect(
			loadView(createViewFile({ kind: 'session', ref: 'store/main', from: 'active' })),
		).toEqual({ kind: 'session', ref: 'store/main', from: 'active' });

		const other = createViewFile();

		writeFileSync(other, '{"kind":"session","ref":"store/main","from":"grid"}');
		expect(loadView(other)).toBeNull();
	});

	it.each([
		[{ kind: 'machines' }, { kind: 'active' }],
		[{ kind: 'grid' }, { kind: 'activate' }],
		[
			{ kind: 'grid', machine: 'vm1' },
			{ kind: 'activate', machine: 'vm1' },
		],
		[{ kind: 'grid', machine: 7 }, { kind: 'activate' }],
		[{ kind: 'pinned' }, { kind: 'active' }],
		[
			{ kind: 'session', ref: 'a/b', from: 'pinned' },
			{ kind: 'session', ref: 'a/b', from: 'active' },
		],
		[
			{ kind: 'session', ref: 'a/b' },
			{ kind: 'session', ref: 'a/b' },
		],
		[{ kind: 'settings' }, { kind: 'settings' }],
		['grid', 'grid'],
		[null, null],
	])('migrateSavedView %j → %j', (saved, migrated) => {
		expect(migrateSavedView(saved)).toEqual(migrated);
	});

	it('saved by the release before Activate: the machine cards → Active, a grid → Activate', () => {
		expect(loadView(createViewFile({ kind: 'machines' } as unknown as View))).toEqual({
			kind: 'active',
		});
		expect(loadView(createViewFile({ kind: 'grid', machine: 'vm1' } as unknown as View))).toEqual({
			kind: 'activate',
			machine: 'vm1',
		});
	});

	it('saved before the active set: Pinned → Active, a session from Pinned → from Active', () => {
		expect(loadView(createViewFile({ kind: 'pinned' } as unknown as View))).toEqual({
			kind: 'active',
		});
		expect(
			loadView(
				createViewFile({ kind: 'session', ref: 'store/main', from: 'pinned' } as unknown as View),
			),
		).toEqual({ kind: 'session', ref: 'store/main', from: 'active' });
	});

	it('missing or corrupt file → nothing restored', () => {
		const corrupt = createViewFile();

		writeFileSync(corrupt, '{"kind":"session"}');

		expect(loadView(corrupt)).toBeNull();
		expect(loadView(join(tmpdir(), 'voiceos-no-such-view.json'))).toBeNull();
	});
});
