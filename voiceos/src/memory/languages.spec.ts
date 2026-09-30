import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../state/store.js';
import { configureLog } from '../log.js';
import { loadLanguages, persistLanguages } from './languages.js';

configureLog({ quiet: true });

const scratch = () => join(mkdtempSync(join(tmpdir(), 'voiceos-languages-')), 'languages.json');

describe('the speech languages', () => {
	it('no file, or a broken one → English', () => {
		const file = scratch();

		expect(loadLanguages(file)).toEqual(['en']);
		writeFileSync(file, '{not json');
		expect(loadLanguages(file)).toEqual(['en']);
	});

	it('loaded into the state at boot; a change is written back', () => {
		const file = scratch();
		writeFileSync(file, JSON.stringify(['sl']));
		const store = new Store();

		persistLanguages({ store, file });
		expect(store.state.languages).toEqual(['sl']);

		store.dispatch({ type: 'set_languages', languages: ['en', 'sl'] });
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(['en', 'sl']);
	});
});
