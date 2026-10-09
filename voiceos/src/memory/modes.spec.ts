import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import { Store } from '../state/store.js';
import { worktree } from '../../test/support/reduce.js';
import { loadModes, persistModes, saveModes } from './modes.js';

configureLog({ quiet: true });

const createModesFile = (content?: string): string => {
	const file = join(mkdtempSync(join(tmpdir(), 'voiceos-modes-')), 'modes.json');

	if (content !== undefined) {
		writeFileSync(file, content);
	}

	return file;
};

const bootStore = (): Store => {
	const store = new Store();

	store.dispatch({ type: 'worktrees', worktrees: [worktree('crew/main'), worktree('crew/wrk1')] });

	return store;
};

describe('loadModes / saveModes', () => {
	it('saved → read back', () => {
		const file = createModesFile();

		saveModes(file, { 'crew/main': { mode: 'plan', beforePlan: 'ask' } });

		expect(loadModes(file)).toEqual({ 'crew/main': { mode: 'plan', beforePlan: 'ask' } });
	});

	it('missing, corrupt, a list, or a stray entry → what can be read, or nothing', () => {
		expect(loadModes(join(tmpdir(), 'voiceos-no-such-modes.json'))).toEqual({});
		expect(loadModes(createModesFile('{not json'))).toEqual({});
		expect(loadModes(createModesFile('["crew/main"]'))).toEqual({});
		expect(
			loadModes(createModesFile('{"crew/main": {"mode": "ask"}, "crew/wrk1": "skip"}')),
		).toEqual({ 'crew/main': { mode: 'ask' } });
	});
});

describe('persistModes', () => {
	it('boot → the saved modes in the state; one the reducer refuses is dropped from the file', () => {
		const file = createModesFile('{"crew/main": {"mode": "skip"}, "crew/wrk1": {"mode": "loud"}}');
		const store = bootStore();

		persistModes({ store, file });

		expect(store.state.modes).toEqual({ 'crew/main': { mode: 'skip' } });

		store.dispatch({ type: 'set_mode', ref: 'crew/wrk1', mode: 'plan', by: 'page' });

		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
			'crew/main': { mode: 'skip' },
			'crew/wrk1': { mode: 'plan' },
		});
	});

	it('a mode picked before the saved ones load → kept, and nothing written over them', () => {
		const file = createModesFile('{"crew/main": {"mode": "skip"}}');
		const store = bootStore();

		store.dispatch({ type: 'set_mode', ref: 'crew/wrk1', mode: 'ask', by: 'page' });
		persistModes({ store, file });

		expect(store.state.modes).toEqual({
			'crew/main': { mode: 'skip' },
			'crew/wrk1': { mode: 'ask' },
		});
	});

	it('back to Auto → its entry leaves the file', () => {
		const file = createModesFile('{"crew/main": {"mode": "plan"}}');
		const store = bootStore();

		persistModes({ store, file });
		store.dispatch({ type: 'set_mode', ref: 'crew/main', mode: 'auto', by: 'voice' });

		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
	});
});
