import { describe, expect, it } from 'bun:test';
import { readGolden } from '../../../test/support/fake-crew.js';
import type { CrewSetupStatus } from '../setup/types.js';
import {
	describeReady,
	firstStepFor,
	isCleanFinish,
	listRunnerRows,
	progressOf,
} from './first-run.js';

const status = (name: string): CrewSetupStatus => readGolden<CrewSetupStatus>(`${name}.json`);

const rowText = (doc: CrewSetupStatus | null): string[] =>
	listRunnerRows(doc).map(
		(row) =>
			`${row.project} ${row.state} [${row.steps.map((step) => `${step.name}:${step.state}`).join(', ')}] ${row.side}`,
	);

describe('where the first run starts after the opening', () => {
	it('nothing added → pick projects; projects already here → make a workspace', () => {
		expect(firstStepFor([])).toBe('projects');
		expect(firstStepFor([{ name: 'store-front', path: '/code/store-front', remote: '' }])).toBe(
			'workspace',
		);
	});
});

describe("a worktree being made, as the first run draws it (crew's setup status goldens)", () => {
	it('ok → every row ready with its steps done; moves on by itself', () => {
		const doc = status('setup-status-ok');

		expect(rowText(doc)).toEqual([
			'store-front ok [checkout:ok, pnpm install:ok, smoke web:ok] ready',
		]);
		expect(progressOf(doc)).toBe(1);
		expect(isCleanFinish(doc)).toBe(true);
	});

	it('failed → that row failed, the rest ready; never moves on by itself', () => {
		const doc = status('setup-status-failed');
		const rows = listRunnerRows(doc);

		expect(rows.map((row) => `${row.project} ${row.state} ${row.side}`)).toContain(
			'store-api failed failed',
		);
		expect(progressOf(doc)).toBe(1);
		expect(isCleanFinish(doc)).toBe(false);
	});

	it('starting → the running step names the row; a project with no step yet waits', () => {
		const doc = status('setup-status-starting');

		expect(rowText(doc)).toEqual([
			'store-front running [checkout:ok, pnpm install:wait] pnpm install',
			'store-api waiting [] waiting',
		]);
		// store-front: one of its two listed steps done, out of three counting the one to come.
		expect(progressOf(doc)).toBeCloseTo((1 / 3 + 0) / 2);
		expect(isCleanFinish(doc)).toBe(false);
	});

	it('an interrupted runner is a failed one', () => {
		const doc = status('setup-status-ok');
		const interrupted = {
			...doc,
			projects: doc.projects.map((project) => ({ ...project, state: 'interrupted' })),
		};

		expect(listRunnerRows(interrupted).map((row) => row.state)).toEqual(['failed']);
		expect(isCleanFinish(interrupted)).toBe(false);
	});

	it('not read yet, or nothing started → no rows, no progress, never moves on', () => {
		expect(listRunnerRows(null)).toEqual([]);
		expect(progressOf(null)).toBe(0);
		expect(isCleanFinish(null)).toBe(false);
		expect(isCleanFinish(status('setup-status-none'))).toBe(false);
	});
});

describe('what the last step says', () => {
	const ok = status('setup-status-ok');
	const failed = status('setup-status-failed');

	it('every project installed → counted, Voice OS first', () =>
		expect(describeReady(ok)).toEqual({
			lead: '1 project checked out and installed.',
			isNothingInstalled: false,
		}));

	it('one failed among them → how many installed and which failed', () =>
		expect(describeReady(failed)).toEqual({
			lead: '1 of 2 projects installed; store-api failed: Set up shows it.',
			isNothingInstalled: false,
		}));

	it('nothing installed → said plainly, Set up first', () => {
		const none = {
			...ok,
			projects: ok.projects.map((project) => ({ ...project, state: 'failed' })),
		};

		expect(describeReady(none)).toEqual({
			lead: 'Nothing installed; store-front failed: Set up shows it.',
			isNothingInstalled: true,
		});
	});
});
