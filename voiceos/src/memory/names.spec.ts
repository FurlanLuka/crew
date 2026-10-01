import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import { Store } from '../state/store.js';
import { worktree } from '../../test/support/reduce.js';
import { loadNames, persistNames, saveNames } from './names.js';

configureLog({ quiet: true });

const VM1 = { id: 'vm1', host: 'vm1', name: 'Personal' };

const createNamesFile = (content?: string): string => {
	const file = join(mkdtempSync(join(tmpdir(), 'voiceos-names-')), 'names.json');

	if (content !== undefined) {
		writeFileSync(file, content);
	}

	return file;
};

// Booted as app.ts does: machines and worktrees are in the state before the names load.
const bootStore = (): Store => {
	const store = new Store();

	store.dispatch({ type: 'machines', machines: [VM1] });
	store.dispatch({ type: 'worktrees', worktrees: [worktree('crew/main'), worktree('crew/wrk1')] });

	return store;
};

describe('loadNames / saveNames', () => {
	it('saved → read back', () => {
		const file = createNamesFile();

		saveNames(file, { 'vm1:crew/main': 'voice os dev', 'crew/main': 'shop' });

		expect(loadNames(file)).toEqual({ 'vm1:crew/main': 'voice os dev', 'crew/main': 'shop' });
	});

	it('missing, corrupt, a list, or a stray entry → what can be read, or nothing', () => {
		expect(loadNames(join(tmpdir(), 'voiceos-no-such-names.json'))).toEqual({});
		expect(loadNames(createNamesFile('{not json'))).toEqual({});
		expect(loadNames(createNamesFile('["crew/main"]'))).toEqual({});
		expect(loadNames(createNamesFile('{"crew/main": "shop", "crew/wrk1": 3, "a/b": " "}'))).toEqual(
			{ 'crew/main': 'shop' },
		);
	});
});

describe('persistNames', () => {
	it('boot → the saved names in the state, those of an unknown machine dropped from the file', () => {
		const file = createNamesFile('{"gpu:crew/main": "gpu dev", "vm1:crew/main": "voice os dev"}');
		const store = bootStore();

		persistNames({ store, file });

		expect(store.state.names).toEqual({ 'vm1:crew/main': 'voice os dev' });
		expect(loadNames(file)).toEqual({ 'vm1:crew/main': 'voice os dev' });
	});

	it('a name given before the file was read → nothing written until it is, then both kept', () => {
		const file = createNamesFile('{"crew/main": "shop"}');
		const store = bootStore();

		store.dispatch({ type: 'rename_session', ref: 'crew/wrk1', name: 'docs' });
		expect(loadNames(file)).toEqual({ 'crew/main': 'shop' });

		persistNames({ store, file });

		expect(loadNames(file)).toEqual({ 'crew/main': 'shop', 'crew/wrk1': 'docs' });
	});

	it('rename and clear → written each time; an input that changes no name → no write', () => {
		const file = createNamesFile();
		const store = bootStore();

		persistNames({ store, file });
		expect(existsSync(file)).toBe(false);

		store.dispatch({ type: 'rename_session', ref: 'crew/wrk1', name: 'docs' });
		expect(loadNames(file)).toEqual({ 'crew/wrk1': 'docs' });

		store.dispatch({ type: 'rename_session', ref: 'crew/wrk1', name: '' });
		expect(loadNames(file)).toEqual({});

		writeFileSync(file, '{"sentinel": "x"}');
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		store.dispatch({ type: 'rename_session', ref: 'crew/main', name: '' });
		expect(loadNames(file)).toEqual({ sentinel: 'x' });
	});

	it('a machine gone from machines.json → its names dropped from the file too', () => {
		const file = createNamesFile('{"vm1:crew/main": "voice os dev", "crew/main": "shop"}');
		const store = bootStore();

		persistNames({ store, file });
		store.dispatch({ type: 'machines', machines: [] });

		expect(loadNames(file)).toEqual({ 'crew/main': 'shop' });
	});
});
