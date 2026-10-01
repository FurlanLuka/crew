import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import { Store } from './store.js';

const captureWarnings = (): (() => { msg: string; type?: string; during?: string }[]) => {
	const file = join(mkdtempSync(join(tmpdir(), 'store-log-')), 'log.jsonl');
	configureLog({ file, quiet: true });

	return () =>
		readFileSync(file, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as { level: string; msg: string; type?: string; during?: string },
			)
			.filter((entry) => entry.level === 'warn');
};

afterEach(() => {
	configureLog({ quiet: true });
});

describe('Store', () => {
	it('a listener that dispatches → warned, naming both inputs', () => {
		const readWarnings = captureWarnings();
		const store = new Store();
		store.subscribe((stamped) => {
			if (stamped.input.type === 'meanwhile_added') {
				store.dispatch({ type: 'play_meanwhile' });
			}
		});

		store.dispatch({ type: 'meanwhile_added', ref: 'store/main', kind: 'done', about: null });

		expect(readWarnings()).toEqual([
			expect.objectContaining({
				msg: 'dispatch inside a listener: pages may see it out of order',
				type: 'play_meanwhile',
				during: 'meanwhile_added',
			}),
		]);
	});

	it('a dispatch from an effect handler, after every listener → no warning', () => {
		const readWarnings = captureWarnings();
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{
					ref: 'store/main',
					label: 'store/main',
					branch: '',
					cwd: '/w',
					dirs: [],
					isPinned: false,
				},
			],
		});
		let dispatched = false;
		store.onEffect(() => {
			if (!dispatched) {
				dispatched = true;
				store.dispatch({ type: 'play_meanwhile' });
			}
		});
		store.subscribe(() => {});

		// Its worker_start effect is what the handler dispatches from.
		store.dispatch({ type: 'activate', ref: 'store/main' });

		expect(dispatched).toBe(true);
		expect(readWarnings()).toEqual([]);
	});
});
