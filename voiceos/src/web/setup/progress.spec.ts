import { describe, expect, it } from 'bun:test';
import { readGolden } from '../../../test/support/fake-crew.js';
import { isRunning, listFailedProjects, listProgressLines } from './progress.js';
import type { CrewSetupStatus } from './types.js';

const status = (name: string): CrewSetupStatus => readGolden<CrewSetupStatus>(`${name}.json`);

const lineText = (doc: CrewSetupStatus): string[] =>
	listProgressLines(doc).map(
		(line) =>
			`${line.state} ${line.what} · ${[line.detail, line.took].filter(Boolean).join(' · ')}`,
	);

describe('a setup runner as Set up draws it (crew setup status goldens)', () => {
	it('ok → every step done with its time; not running, nothing failed', () => {
		const doc = status('setup-status-ok');

		expect(lineText(doc)).toEqual([
			'ok checkout · store-front · 1.2 s',
			'ok pnpm install · store-front · 38.0 s',
			'ok smoke web · store-front · 2.8 s',
		]);
		expect(isRunning(doc)).toBe(false);
		expect(listFailedProjects(doc)).toEqual([]);
	});

	it("failed → the failed step says crew's first line; that project is the failed one", () => {
		const doc = status('setup-status-failed');

		expect(lineText(doc).slice(3)).toEqual([
			'ok checkout · store-api · 900 ms',
			'ask pnpm install · store-api · ERR_PNPM_NO_MATCHING_VERSION · 8.1 s',
		]);
		expect(isRunning(doc)).toBe(false);
		expect(listFailedProjects(doc).map((project) => project.project)).toEqual(['store-api']);
	});

	it('starting → the running step is working, a project with no step yet is starting', () => {
		const doc = status('setup-status-starting');

		expect(lineText(doc)).toEqual([
			'ok checkout · store-front · 1.2 s',
			'wait pnpm install · store-front · working…',
			'wait starting · store-api',
		]);
		expect(isRunning(doc)).toBe(true);
	});

	it('none → no lines, not running (nothing was ever started)', () => {
		const doc = status('setup-status-none');

		expect(listProgressLines(doc)).toEqual([]);
		expect(isRunning(doc)).toBe(false);
	});

	it('not read yet → running: the page keeps waiting', () => {
		expect(isRunning(null)).toBe(true);
	});
});
