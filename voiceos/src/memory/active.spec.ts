import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import { Store } from '../state/store.js';
import { worktree } from '../../test/support/reduce.js';
import { loadActive, persistActive } from './active.js';

configureLog({ quiet: true });

const VM1 = { id: 'vm1', host: 'vm1', name: 'build box' };

interface ActiveFiles {
	file: string;
	legacyFile: string;
}

// active.json and the pinned.json it replaces, each written only when given.
const createFiles = ({
	active,
	pinned,
}: {
	active?: string;
	pinned?: string;
} = {}): ActiveFiles => {
	const dir = mkdtempSync(join(tmpdir(), 'voiceos-active-'));
	const files = { file: join(dir, 'active.json'), legacyFile: join(dir, 'pinned.json') };

	if (active !== undefined) {
		writeFileSync(files.file, active);
	}

	if (pinned !== undefined) {
		writeFileSync(files.legacyFile, pinned);
	}

	return files;
};

const readFile = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

// Booted as app.ts does: machines and worktrees are in the state before the active set loads.
const bootStore = (): Store => {
	const store = new Store();

	store.dispatch({ type: 'machines', machines: [VM1] });
	store.dispatch({
		type: 'worktrees',
		worktrees: [worktree('store/main'), worktree('store/wrk1')],
	});

	return store;
};

describe('loadActive', () => {
	it('neither file → nothing active, nothing written', () => {
		const files = createFiles();

		expect(loadActive(files)).toEqual([]);
		expect(existsSync(files.file)).toBe(false);
	});

	it('pinned.json only → its pins become the set in their order, written to active.json', () => {
		const files = createFiles({ pinned: '["vm1:store/main", "store/wrk1", "store/main"]' });

		expect(loadActive(files)).toEqual(['vm1:store/main', 'store/wrk1', 'store/main']);
		expect(readFile(files.file)).toEqual(['vm1:store/main', 'store/wrk1', 'store/main']);
	});

	it("a pinned setup → dropped: this Mac's setup is always active and never stored", () => {
		const files = createFiles({ pinned: '["setup", "store/main", "vm1:setup"]' });

		expect(loadActive(files)).toEqual(['store/main', 'vm1:setup']);
		expect(readFile(files.file)).toEqual(['store/main', 'vm1:setup']);
	});

	it('active.json emptied, pinned.json still there → stays empty, the pins not read again', () => {
		const files = createFiles({ active: '[]', pinned: '["store/main"]' });

		expect(loadActive(files)).toEqual([]);
	});

	it('both → active.json wins', () => {
		const files = createFiles({ active: '["store/wrk1"]', pinned: '["store/main"]' });

		expect(loadActive(files)).toEqual(['store/wrk1']);
	});

	it('active.json corrupt → empty, not the old pins', () => {
		const files = createFiles({ active: '{not json', pinned: '["store/main"]' });

		expect(loadActive(files)).toEqual([]);
	});

	it('not a list, or a stray entry → what can be read, or nothing', () => {
		expect(loadActive(createFiles({ active: '{"refs":["store/main"]}' }))).toEqual([]);
		expect(loadActive(createFiles({ active: '["store/main", 3, "", "setup"]' }))).toEqual([
			'store/main',
		]);
	});
});

describe('persistActive', () => {
	it('boot → the saved set in the state, an unknown machine dropped from the file', () => {
		const files = createFiles({ active: '["gpu:store/main", "vm1:store/main", "store/main"]' });
		const store = bootStore();

		persistActive({ store, ...files });

		expect(store.state.active).toEqual(['vm1:store/main', 'store/main']);
		expect(readFile(files.file)).toEqual(['vm1:store/main', 'store/main']);
	});

	it('boot from pinned.json → the pins are the set and the active sessions start', () => {
		const files = createFiles({ pinned: '["store/main"]' });
		const store = bootStore();

		persistActive({ store, ...files });

		expect(store.state.active).toEqual(['store/main']);
		expect(store.state.sessions['store/main']?.status).toBe('starting');
		expect(store.state.sessions['store/wrk1']?.status).toBe('stopped');
	});

	it('activated before the file was read → nothing written until it is, then both kept', () => {
		const files = createFiles({ active: '["store/main"]' });
		const store = bootStore();

		store.dispatch({ type: 'activate', ref: 'store/wrk1' });
		// Stands in for a write racing the boot: the file still holds what the last run saved.
		expect(readFile(files.file)).toEqual(['store/main']);

		persistActive({ store, ...files });

		expect(readFile(files.file)).toEqual(['store/main', 'store/wrk1']);
	});

	it('activate and deactivate → written each time; an input that changes no set → no write', () => {
		const files = createFiles({ active: '[]' });
		const store = bootStore();

		persistActive({ store, ...files });

		store.dispatch({ type: 'activate', ref: 'store/wrk1' });
		expect(readFile(files.file)).toEqual(['store/wrk1']);

		store.dispatch({ type: 'deactivate', ref: 'store/wrk1' });
		expect(readFile(files.file)).toEqual([]);

		writeFileSync(files.file, '["sentinel"]');
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		expect(readFile(files.file)).toEqual(['sentinel']);
	});

	it('a machine gone from machines.json → its sessions dropped from the file too', () => {
		const files = createFiles({ active: '["vm1:store/main", "store/main"]' });
		const store = bootStore();

		persistActive({ store, ...files });
		store.dispatch({ type: 'machines', machines: [] });

		expect(readFile(files.file)).toEqual(['store/main']);
	});
});
