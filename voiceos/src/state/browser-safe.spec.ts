import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The page runs the same reducer on every input it receives: anything it imports must run in a
// browser. The server log writes to process.stdout, so a reducer module that logs reloads the page.
const SERVER_ONLY = new Set(['store.ts']);

describe('the reducer runs in the page', () => {
	it('no state module but the store imports the server log', () => {
		const dir = import.meta.dir;
		const logging = readdirSync(dir).filter(
			(file) =>
				file.endsWith('.ts') &&
				!file.endsWith('.spec.ts') &&
				!SERVER_ONLY.has(file) &&
				/from '\.\.\/log\.js'/.test(readFileSync(join(dir, file), 'utf8')),
		);

		expect(logging).toEqual([]);
	});
});
