import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../log.js';
import { LOCAL_MACHINE, machineOf } from '../shared/machine-ref.js';
import type { State, View } from '../shared/protocol.js';
import type { Store } from '../state/store.js';

const log = createLogger('view');

// A remote machine's worktrees arrive only once it reconnects; past this its session is not coming.
export const VIEW_RESTORE_MS = 60_000;
// A page that connects later than this after boot opened fresh, not after a restart it lived through.
export const RESTART_ANNOUNCE_MS = 2 * 60_000;

export type ViewRestore = { kind: 'apply'; view: View } | { kind: 'wait' } | { kind: 'drop' };

const isView = (value: unknown): value is View => {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const view = value as Record<string, unknown>;

	switch (view.kind) {
		case 'machines':
			return true;
		case 'grid':
			return view.machine === undefined || typeof view.machine === 'string';
		case 'session':
			return typeof view.ref === 'string';
		default:
			return false;
	}
};

export const loadView = (file: string): View | null => {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;

		return isView(parsed) ? parsed : null;
	} catch {
		// A missing or corrupt file opens on the home view, as a first start does.
		return null;
	}
};

export const saveView = (file: string, view: View): void => {
	mkdirSync(dirname(file), { recursive: true });

	// Write-then-rename: a crash mid-write leaves the previous file intact.
	const temporaryFile = `${file}.${process.pid}.tmp`;

	writeFileSync(temporaryFile, JSON.stringify(view, null, 2));
	renameSync(temporaryFile, file);
};

export const restoredView = (saved: View, state: State, waitedMs = 0): ViewRestore => {
	if (saved.kind === 'machines') {
		return { kind: 'apply', view: saved };
	}

	// Past the wait a restore would yank a developer who has been looking elsewhere for a minute, even
	// if the machine turns up just now.
	if (waitedMs >= VIEW_RESTORE_MS) {
		return { kind: 'drop' };
	}

	const machine = saved.kind === 'grid' ? saved.machine : machineOf(saved.ref);
	const isKnown =
		saved.kind === 'grid'
			? !machine || machine === LOCAL_MACHINE || Boolean(state.machines[machine])
			: Boolean(state.sessions[saved.ref]);

	if (isKnown) {
		return { kind: 'apply', view: saved };
	}

	// This Mac's worktrees are read before the restore; a remote machine's snapshot says it all once
	// it is connected. Either way, a session missing then is gone.
	const hasArrived = !machine || state.machines[machine]?.status === 'connected';

	return hasArrived ? { kind: 'drop' } : { kind: 'wait' };
};

interface AnnounceRestartParams {
	bootAt: number;
	now: number;
	isSaid: boolean;
	// view.json is written only by a Voice OS that ran and was looked at: without one this boot is a
	// first start, and "restarted" would be news about nothing.
	hadSavedView: boolean;
}

export const shouldAnnounceRestart = ({
	bootAt,
	now,
	isSaid,
	hadSavedView,
}: AnnounceRestartParams): boolean =>
	hadSavedView && !isSaid && now - bootAt <= RESTART_ANNOUNCE_MS;

interface PersistViewParams {
	store: Store;
	file: string;
	now?: () => number;
}

// Returns whether a saved view was there at boot: that is what tells a restart from a first start.
export const persistView = ({ store, file, now = Date.now }: PersistViewParams): boolean => {
	// crew rewrites state.json at every launch, so the view keeps its own file.
	const saved = loadView(file);
	const startedAt = now();
	let isPending = saved !== null;

	const settle = (state: State): void => {
		if (!saved || !isPending) {
			return;
		}

		const restore = restoredView(saved, state, now() - startedAt);

		if (restore.kind === 'wait') {
			return;
		}

		isPending = false;

		if (restore.kind === 'apply') {
			// After this input's listeners have all run: the pages see the inputs in order.
			queueMicrotask(() => store.dispatch({ type: 'restore_view', view: restore.view }));
		}
	};

	store.subscribe((stamped, state) => {
		if (stamped.input.type === 'switch_view') {
			// The developer chose where to look: a restore still waiting must not move them.
			isPending = false;

			try {
				saveView(file, state.view);
			} catch (error) {
				log.warn('view not saved', { error: String(error) });
			}

			return;
		}

		settle(state);
	});

	settle(store.state);

	return saved !== null;
};
