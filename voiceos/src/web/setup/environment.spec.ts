import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeBindingSource, readPreview, readProposals } from './environment.js';

const golden = (name: string): unknown =>
	JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'testdata', name), 'utf8'));

describe('describeBindingSource', () => {
	it.each([
		['{{checkout-api}}', "checkout-api's URL"],
		['{{store-front/api}}', "store-front api's URL"],
		['{{store-front/api.port}}', "store-front api's port"],
		['{{signals.host}}', "signals's host"],
		['{{worktree}}', "the worktree's name"],
		['{{url:checkout-api}}', "checkout-api's URL"],
		['development', 'development, fixed'],
		['ws://{{signals.host}}/rtc', `signals's host, inside "ws://{{signals.host}}/rtc"`],
	])('%s → %s', (value, words) => expect(describeBindingSource(value)).toBe(words));
});

describe('the .env proposals crew makes', () => {
	it('proposed rows carry their template; ambiguous ones need a pick; bound ones are left out', () =>
		expect(readProposals(golden('add-binding-scan.json'))).toEqual([
			{
				var: 'SIGNALS_URL',
				value: '{{signals}}',
				note: "=http://localhost:5000 · looks like signals's URL",
			},
			{
				var: 'ADMIN_URL',
				value: null,
				note: '=http://localhost:3000 · two projects configured on :3000 — pick one by hand',
			},
		]));
});

describe('the Environment preview (a dry run)', () => {
	it('each worktree with what it would get, or why not', () =>
		expect(readPreview(golden('add-binding-dry-run.json'))).toEqual({
			error: null,
			rows: [
				{ worktree: 'store-front/main', value: 'http://localhost:54012', error: null },
				{ worktree: 'store-front/wrk1', value: 'http://localhost:54031', error: null },
				{ worktree: 'admin/main', value: null, error: 'store-api is not in this workspace' },
			],
		}));

	it("a template crew can't parse → crew's own error", () =>
		expect(readPreview(golden('add-binding-dry-run-error.json')).error).toContain(
			'a server is written {{project/server}}',
		));
});
