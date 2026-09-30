import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import { Store } from '../state/store.js';
import { worktree } from '../../test/support/reduce.js';
import { loadPinned, persistPinned, savePinned } from './pinned.js';

configureLog({ quiet: true });

const VM1 = { id: 'vm1', host: 'vm1', name: 'build box' };

const createPinnedFile = (content?: string): string => {
	const file = join(mkdtempSync(join(tmpdir(), 'voiceos-pinned-')), 'pinned.json');

	if (content !== undefined) {
		writeFileSync(file, content);
	}

	return file;
};

// Booted as app.ts does: machines and worktrees are in the state before the pins load.
const bootStore = (): Store => {
	const store = new Store();

	store.dispatch({ type: 'machines', machines: [VM1] });
	store.dispatch({
		type: 'worktrees',
		worktrees: [worktree('store/main'), worktree('store/wrk1')],
	});

	return store;
};

describe('loadPinned / savePinned', () => {
	it('saved → read back in order', () => {
		const file = createPinnedFile();

		savePinned(file, ['vm1:store/main', 'store/main']);

		expect(loadPinned(file)).toEqual(['vm1:store/main', 'store/main']);
	});

	it('missing, corrupt, not a list, or a stray entry → what can be read, or nothing', () => {
		expect(loadPinned(join(tmpdir(), 'voiceos-no-such-pinned.json'))).toEqual([]);
		expect(loadPinned(createPinnedFile('{not json'))).toEqual([]);
		expect(loadPinned(createPinnedFile('{"refs":["store/main"]}'))).toEqual([]);
		expect(loadPinned(createPinnedFile('["store/main", 3, ""]'))).toEqual(['store/main']);
	});
});

describe('persistPinned', () => {
	it('boot → the saved pins in the state, those of an unknown machine dropped from the file', () => {
		const file = createPinnedFile('["gpu:store/main", "vm1:store/main", "store/main"]');
		const store = bootStore();

		persistPinned({ store, file });

		expect(store.state.pinned).toEqual(['vm1:store/main', 'store/main']);
		expect(loadPinned(file)).toEqual(['vm1:store/main', 'store/main']);
	});

	it('a pin made before the file was read → nothing written until it is, then both kept', () => {
		const file = createPinnedFile('["store/main"]');
		const store = bootStore();

		store.dispatch({ type: 'pin_session', ref: 'store/wrk1' });
		// Stands in for a write racing the boot: the file still holds what the last run saved.
		expect(loadPinned(file)).toEqual(['store/main']);

		persistPinned({ store, file });

		expect(loadPinned(file)).toEqual(['store/main', 'store/wrk1']);
	});

	it('pin and unpin → written each time; an input that changes no pin → no write', () => {
		const file = createPinnedFile();
		const store = bootStore();

		persistPinned({ store, file });
		expect(existsSync(file)).toBe(false);

		store.dispatch({ type: 'pin_session', ref: 'store/wrk1' });
		expect(loadPinned(file)).toEqual(['store/wrk1']);

		store.dispatch({ type: 'unpin_session', ref: 'store/wrk1' });
		expect(loadPinned(file)).toEqual([]);

		writeFileSync(file, '["sentinel"]');
		store.dispatch({ type: 'switch_view', view: { kind: 'pinned' } });
		expect(loadPinned(file)).toEqual(['sentinel']);
	});

	it('a machine gone from machines.json → its pins dropped from the file too', () => {
		const file = createPinnedFile('["vm1:store/main", "store/main"]');
		const store = bootStore();

		persistPinned({ store, file });
		store.dispatch({ type: 'machines', machines: [] });

		expect(loadPinned(file)).toEqual(['store/main']);
	});
});
