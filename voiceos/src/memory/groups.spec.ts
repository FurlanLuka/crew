import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import type { SessionGroup } from '../shared/protocol.js';
import { Store } from '../state/store.js';
import { worktree } from '../../test/support/reduce.js';
import { loadGroups, persistGroups, saveGroups } from './groups.js';

configureLog({ quiet: true });

const VM1 = { id: 'vm1', host: 'vm1', name: 'Build box' };
const STORE: SessionGroup = {
	id: 'g1',
	name: 'store',
	color: 'teal',
	refs: ['crew/main', 'crew/wrk1'],
};

const createGroupsFile = (content?: string): string => {
	const file = join(mkdtempSync(join(tmpdir(), 'voiceos-groups-')), 'groups.json');

	if (content !== undefined) {
		writeFileSync(file, content);
	}

	return file;
};

// Booted as app.ts does: machines, worktrees and the active set are in the state before the groups load.
const bootStore = (): Store => {
	const store = new Store();
	const refs = ['crew/main', 'crew/wrk1', 'crew/wrk2', 'vm1:crew/main'];

	store.dispatch({ type: 'machines', machines: [VM1] });
	store.dispatch({ type: 'worktrees', worktrees: refs.map(worktree) });
	store.dispatch({ type: 'active_loaded', refs });

	return store;
};

describe('loadGroups / saveGroups', () => {
	it('saved → read back, the open group with them', () => {
		const file = createGroupsFile();

		saveGroups(file, { groups: [STORE], openGroup: 'g1' });

		expect(loadGroups(file)).toEqual({ groups: [STORE], openGroup: 'g1' });
	});

	it('missing, corrupt or a list → none; stray entries (a bad colour, no name, refs not strings, an id twice, an id not g<n>) → what can be read, a long name cut', () => {
		const none = { groups: [], openGroup: null };

		expect(loadGroups(join(tmpdir(), 'voiceos-no-such-groups.json'))).toEqual(none);
		expect(loadGroups(createGroupsFile('{not json'))).toEqual(none);
		expect(loadGroups(createGroupsFile('[]'))).toEqual(none);

		const file = createGroupsFile(
			JSON.stringify({
				groups: [
					{ ...STORE, refs: ['crew/main', 4, 'crew/wrk1'] },
					{ ...STORE, name: 'again' },
					{ ...STORE, id: 'g2', color: 'red' },
					{ ...STORE, id: 'g3', name: ' ' },
					{ ...STORE, id: 'store' },
					{ ...STORE, id: 'g5', name: `  ${'x'.repeat(50)}` },
					'g4',
				],
				openGroup: 7,
			}),
		);

		expect(loadGroups(file)).toEqual({
			groups: [STORE, { ...STORE, id: 'g5', name: 'x'.repeat(40) }],
			openGroup: null,
		});
	});
});

describe('persistGroups', () => {
	it('boot → the saved groups in the state', () => {
		const file = createGroupsFile(JSON.stringify({ groups: [STORE], openGroup: 'g1' }));
		const store = bootStore();

		persistGroups({ store, file });

		expect(store.state.groups).toEqual([STORE]);
		expect(store.state.openGroup).toBe('g1');
	});

	it('a group made before the file was read → nothing written until it is, then both kept', () => {
		const file = createGroupsFile(JSON.stringify({ groups: [STORE], openGroup: null }));
		const store = bootStore();

		store.dispatch({
			type: 'create_group',
			refs: ['crew/wrk2', 'vm1:crew/main'],
			name: 'other',
			color: 'pink',
		});
		expect(loadGroups(file).groups).toEqual([STORE]);

		persistGroups({ store, file });

		expect(loadGroups(file).groups.map((group) => [group.id, group.name])).toEqual([
			['g1', 'other'],
			['g2', 'store'],
		]);
	});

	it('each change written; an input that changes no group → no write', () => {
		const file = createGroupsFile();
		const store = bootStore();

		persistGroups({ store, file });
		expect(existsSync(file)).toBe(false);

		store.dispatch({
			type: 'create_group',
			refs: ['crew/main', 'crew/wrk1'],
			name: 'store',
			color: 'teal',
		});
		expect(loadGroups(file)).toEqual({ groups: [STORE], openGroup: null });

		store.dispatch({ type: 'open_group', id: 'g1' });
		expect(loadGroups(file).openGroup).toBe('g1');

		writeFileSync(file, '{"sentinel": true}');
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		store.dispatch({ type: 'rename_session', ref: 'crew/main', name: 'shop' });
		expect(loadGroups(file)).toEqual({ groups: [], openGroup: null });
	});

	it('a machine gone from machines.json → its sessions dropped from the file too', () => {
		const file = createGroupsFile(
			JSON.stringify({
				groups: [{ ...STORE, refs: ['crew/main', 'crew/wrk1', 'vm1:crew/main'] }],
				openGroup: null,
			}),
		);
		const store = bootStore();

		persistGroups({ store, file });
		store.dispatch({ type: 'machines', machines: [] });

		expect(loadGroups(file).groups).toEqual([STORE]);
	});
});
