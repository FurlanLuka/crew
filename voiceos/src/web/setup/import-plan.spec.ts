import { describe, expect, it } from 'bun:test';
import { readGolden } from '../../../test/support/fake-crew.js';
import {
	type Choice,
	buildRun,
	countOpen,
	describeSummary,
	optionsFor,
	readWorkspace,
	sectionOf,
	startChoices,
} from './import-plan.js';
import { type PlanRow, readPlan } from './readers.js';

// crew's own plan: store-front here, store-api to clone, checkout-api already checked out
// (found), infra-ops with no remote; workspaces store-front (needs store-api) and admin.
const ROWS = readPlan(readGolden<unknown>('import-plan.json'));
const PROJECTS = ROWS.filter((row) => row.kind === 'project');

const row = (name: string, kind: PlanRow['kind'] = 'project'): PlanRow => {
	const found = ROWS.find((each) => each.name === name && each.kind === kind);

	if (!found) {
		throw new Error(`no ${kind} ${name} in the golden`);
	}

	return found;
};

const choose = (choices: Record<string, Choice>, name: string, patch: Partial<Choice>) => ({
	...choices,
	[name]: { ...(choices[name] ?? { kind: null, path: '', rename: `${name}-2` }), ...patch },
});

describe("what each of crew's plan rows offers", () => {
	it('here → kept; to clone → cloned; found → your checkout first; no remote → nothing until you pick', () => {
		expect(PROJECTS.map((each) => [each.name, each.status, optionsFor(each).start])).toEqual([
			['store-front', 'exists', 'keep'],
			['store-api', 'clone', 'clone'],
			['checkout-api', 'found', 'mine'],
			['infra-ops', 'missing', null],
		]);
		expect(optionsFor(row('checkout-api')).options).toEqual(['mine', 'clone']);
		expect(
			optionsFor({ kind: 'project', name: 'x', status: 'other remote', detail: '' }).options,
		).toEqual(['rename', 'replace', 'skip']);
		expect(
			optionsFor({ kind: 'project', name: 'x', status: 'blocked', detail: '' }).start,
		).toBeNull();
	});

	it('the page groups them: choices first, then what will just happen, then what is here', () =>
		expect(PROJECTS.map((each) => sectionOf(each))).toEqual(['here', 'will', 'will', 'needs']));
});

describe('one Import', () => {
	it('waits for every choice; a folder needs its path; skipping counts', () => {
		let choices = startChoices(ROWS);
		expect(countOpen(ROWS, choices)).toBe(1);

		choices = choose(choices, 'infra-ops', { kind: 'folder' });
		expect(countOpen(ROWS, choices)).toBe(1);
		choices = choose(choices, 'infra-ops', { path: '~/code/infra-ops' });
		expect(countOpen(ROWS, choices)).toBe(0);
		expect(countOpen(ROWS, choose(choices, 'infra-ops', { kind: 'skip' }))).toBe(0);
	});

	it('runs the projects as chosen, then the ticked workspaces', () => {
		const choices = choose(startChoices(ROWS), 'infra-ops', {
			kind: 'folder',
			path: '/x/infra-ops',
		});
		const run = buildRun(ROWS, choices, ['admin'], 'BUNDLE');

		expect(run.projects.map((item) => item.command)).toEqual([
			{ type: 'import_project', bundle: 'BUNDLE', name: 'store-api' },
			{
				type: 'import_project',
				bundle: 'BUNDLE',
				name: 'checkout-api',
				path: row('checkout-api').detail,
			},
			{ type: 'import_project', bundle: 'BUNDLE', name: 'infra-ops', path: '/x/infra-ops' },
		]);
		expect(run.workspaces.map((item) => item.command)).toEqual([
			{ type: 'import_workspace', bundle: 'BUNDLE', name: 'admin' },
		]);
	});

	it('rename and replace become their flags; keep and skip run nothing', () => {
		const other: PlanRow = { kind: 'project', name: 'api', status: 'other remote', detail: '' };
		const rows = [other, row('store-front')];

		expect(
			buildRun(rows, { api: { kind: 'rename', path: '', rename: ' api-2 ' } }, [], 'B').projects[0]
				?.command,
		).toEqual({ type: 'import_project', bundle: 'B', name: 'api', rename: 'api-2' });
		expect(
			buildRun(rows, { api: { kind: 'replace', path: '', rename: '' } }, [], 'B').projects[0]
				?.command,
		).toEqual({ type: 'import_project', bundle: 'B', name: 'api', replace: true, confirm: true });
		expect(
			buildRun(
				rows,
				{ api: { kind: 'skip', path: '', rename: '' }, ...startChoices(rows) },
				[],
				'B',
			),
		).toEqual({ projects: [], workspaces: [] });
	});
});

describe('a workspace is made from its members as the export names them', () => {
	const members = ['checkout-api', 'infra-ops'];

	it('waits on a member with no choice yet', () =>
		expect(readWorkspace(row('admin', 'workspace'), members, PROJECTS, startChoices(ROWS))).toEqual(
			{
				name: 'admin',
				members,
				blockedBy: null,
				waitsOn: ['infra-ops'],
			},
		));

	it('a skipped or renamed member, or another repo left under its name, leaves it unmakeable', () => {
		const start = startChoices(ROWS);

		expect(
			readWorkspace(
				row('admin', 'workspace'),
				members,
				PROJECTS,
				choose(start, 'infra-ops', { kind: 'skip' }),
			).blockedBy,
		).toBe('needs infra-ops');
		expect(
			readWorkspace(
				row('admin', 'workspace'),
				members,
				PROJECTS,
				choose(start, 'infra-ops', { kind: 'rename' }),
			).blockedBy,
		).toBe('needs infra-ops');

		const other: PlanRow = { kind: 'project', name: 'api', status: 'other remote', detail: '' };
		const ws: PlanRow = { kind: 'workspace', name: 'w', status: 'ready', detail: '' };
		expect(
			readWorkspace(ws, ['api'], [other], { api: { kind: 'replace', path: '', rename: '' } })
				.blockedBy,
		).toBeNull();
		expect(
			readWorkspace(ws, ['api'], [other], { api: { kind: 'skip', path: '', rename: '' } })
				.blockedBy,
		).toBe('needs api');
	});

	it('one already here is not made again', () =>
		expect(
			readWorkspace({ kind: 'workspace', name: 'w', status: 'exists', detail: '' }, [], [], {})
				.blockedBy,
		).toBe('already here'));
});

it('the summary counts what is open, what clones, what is already checked out and what is here', () =>
	expect(
		describeSummary(ROWS, startChoices(ROWS), ['admin']).map((pill) => `${pill.tone}:${pill.text}`),
	).toEqual([
		'ask:1 project needs a choice',
		':1 clone',
		':1 already checked out',
		':1 workspace',
		':1 already here',
	]));
