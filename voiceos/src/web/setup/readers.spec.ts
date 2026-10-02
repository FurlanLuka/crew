// The page's readers over crew's Go-written goldens: what the page reads is what crew prints.
import { describe, expect, it } from 'bun:test';
import { readGolden } from '../../../test/support/fake-crew.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeCost, readBases, readBundleMembers, readLogText, readPlan } from './readers.js';

describe('readBases (crew ls bases --json)', () => {
	it('each base and how far behind; a failed fetch keeps its error, never a count', () => {
		expect(readBases(readGolden('ls-bases.json'))).toEqual([
			{ project: 'store-front', base: 'main', behind: 3, error: null },
			{ project: 'store-api', base: 'main', behind: 0, error: null },
			{
				project: 'signals',
				base: 'develop',
				behind: null,
				error: 'fetch failed: could not read from remote',
			},
		]);
	});

	it('a workspace with no projects → no rows', () => {
		expect(readBases(readGolden('ls-bases-empty.json'))).toEqual([]);
	});
});

describe('readPlan (crew import - --plan --json)', () => {
	it('one row per project and workspace, with what an import would do', () => {
		expect(
			readPlan(readGolden('import-plan.json')).map(
				(row) => `${row.kind} ${row.name} ${row.status}`,
			),
		).toEqual([
			'project store-front exists',
			'project store-api clone',
			'project checkout-api found',
			'project infra-ops missing',
			'workspace store-front needs',
			'workspace admin needs',
		]);
		expect(readPlan(readGolden('import-plan.json'))[5]?.detail).toBe('checkout-api, infra-ops');
	});
});

describe('describeCost (crew rm … --dry-run --json)', () => {
	it("the workspace's last worktree → its checkouts, and the document says last", () => {
		const doc = readGolden<{ last: boolean }>('rm-worktree-dry-run-last.json');

		expect(doc.last).toBe(true);
		expect(describeCost(doc)).toEqual([
			{ label: 'admin/main · store-front', detail: 'nothing uncommitted · 1 KB' },
		]);
	});

	it('a worktree with work in it → what each checkout loses', () => {
		const rows = describeCost(readGolden('rm-worktree-dry-run.json'));

		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((row) => row.label.includes(' · '))).toBe(true);
	});
});

describe('readLogText (crew dev logs / setup logs --json)', () => {
	it('the cleaned lines as text — no terminal escapes reach the page', () => {
		expect(readLogText(readGolden('dev-logs.json'))).toBe(
			'PORT=3000 pnpm dev\nready on http://localhost:3000',
		);
		expect(readLogText(readGolden('setup-logs.json'))).toContain('ERR_PNPM_NO_MATCHING_VERSION');
	});

	it('no document or no lines → nothing', () => {
		expect(readLogText(undefined)).toBe('');
		expect(readLogText({ lines: [] })).toBe('');
	});
});

describe('readBundleMembers (crew export)', () => {
	const bundle = readFileSync(
		join(import.meta.dir, '..', '..', '..', 'testdata', 'export-bundle.json'),
		'utf8',
	);

	it("each workspace's members by name, as crew wrote them", () =>
		expect([...readBundleMembers(bundle)]).toEqual([
			['store-front', ['store-front', 'store-api']],
			['signals', ['signals']],
		]));

	it('anything else reads as no workspaces', () => {
		expect(readBundleMembers('not json').size).toBe(0);
		expect(readBundleMembers('{"version":2}').size).toBe(0);
	});
});
