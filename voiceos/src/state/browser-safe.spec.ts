import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// The page runs the same reducer on every input it receives: everything it imports must run in a
// browser. The server log writes to process.stdout, so a module on that path that logs reloads the
// page. Type-only imports are erased before the page runs, so they are not followed.
const IMPORT_PATTERN = /^import\s+(?!type\s)[^;]*?from\s+'(\.[^']+)'/gms;
const SERVER_LOG = resolve(import.meta.dir, '../log.ts');

const readImports = (file: string): string[] =>
	[...readFileSync(file, 'utf8').matchAll(IMPORT_PATTERN)]
		.map((match) => join(dirname(file), (match[1] ?? '').replace(/\.js$/, '.ts')))
		.filter((path) => existsSync(path));

// The chain of imports from the reducer to the server log, or null when there is none.
const findPathToLog = (start: string): string[] | null => {
	const seen = new Set<string>();

	const walk = (file: string, chain: string[]): string[] | null => {
		if (file === SERVER_LOG) {
			return [...chain, file];
		}

		if (seen.has(file)) {
			return null;
		}

		seen.add(file);

		for (const next of readImports(file)) {
			const found = walk(next, [...chain, file]);

			if (found) {
				return found;
			}
		}

		return null;
	};

	return walk(start, []);
};

describe('the reducer runs in the page', () => {
	it('nothing the reducer imports, however indirectly, reaches the server log', () => {
		const chain = findPathToLog(resolve(import.meta.dir, 'reducer.ts'));

		expect(
			chain?.map((file) => file.replace(`${resolve(import.meta.dir, '..')}/`, '')),
		).toBeUndefined();
	});
});
