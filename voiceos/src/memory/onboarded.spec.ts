import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../state/store.js';
import { configureLog } from '../log.js';
import { loadOnboarded, persistOnboarded } from './onboarded.js';

configureLog({ quiet: true });

const scratch = () => join(mkdtempSync(join(tmpdir(), 'voiceos-onboarded-')), 'onboarded.json');

describe('onboarded', () => {
	it('no file, or a broken one → not onboarded', () => {
		const file = scratch();

		expect(loadOnboarded(file)).toBe(false);
		writeFileSync(file, '{not json');
		expect(loadOnboarded(file)).toBe(false);
	});

	it('loaded into the state at boot; a change is written back', () => {
		const file = scratch();
		writeFileSync(file, JSON.stringify({ onboarded: true }));
		const store = new Store();

		persistOnboarded({ store, file });
		expect(store.state.onboarded).toBe(true);

		store.dispatch({ type: 'set_onboarded', onboarded: false });
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ onboarded: false });
	});
});
