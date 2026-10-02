// Set up in a real browser: the real page and gateway, a store the test drives, and the fake crew
// (crew's own JSON shapes from voiceos/testdata/) behind /api/crew.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { SetupCommand } from '../../src/crew/commands.js';
import { configureLog } from '../../src/log.js';
import { createWorktree, type PageServer, startPageServer } from './page-server.js';

let browser: Browser;
let server: PageServer;
const pageErrors: string[] = [];

const waitUntil = async (check: () => boolean, timeoutMs = 5000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;

	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error('condition not met in time');
		}

		await Bun.sleep(20);
	}
};

const open = async (
	path: string,
	viewport = { width: 1280, height: 900 },
	storage: Record<string, string> = {},
): Promise<{ context: BrowserContext; page: Page }> => {
	const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });

	if (Object.keys(storage).length) {
		await context.addInitScript((entries) => {
			for (const [key, value] of Object.entries(entries)) {
				localStorage.setItem(key, value);
			}
		}, storage);
	}

	const page = await context.newPage();
	page.on('pageerror', (error) => pageErrors.push(error.message));
	await page.goto(server.loginUrl());
	await page.goto(server.url(path));

	return { context, page };
};

const commandsOf = (type: SetupCommand['type']): SetupCommand[] =>
	server.crew.calls.filter((call) => call.command.type === type).map((call) => call.command);

beforeAll(async () => {
	configureLog({ quiet: true });
	server = startPageServer({ runMs: 600, remotes: ['vm1'] });
	server.store.dispatch({
		type: 'worktrees',
		worktrees: [createWorktree('setup', true), createWorktree('store-front/main')],
	});
	browser = await chromium.launch();
});

beforeEach(() => {
	server.crew.reset('golden');
	server.crew.calls.length = 0;
	server.latency.worktreesMs = 0;
});

afterEach(() => {
	expect(pageErrors.splice(0)).toEqual([]);
});

afterAll(async () => {
	await browser?.close();
	server?.stop();
});

describe('the board', () => {
	it("a machine's projects with their state, the problems strip above, the workspaces with their worktrees as pills", async () => {
		const { context, page } = await open('/setup');
		const table = page.locator('.matrix');
		await table.locator('tr[data-project="store-api"]').waitFor({ timeout: 5000 });

		expect(await page.locator('h1').innerText()).toBe('This Mac');
		expect(await page.locator('.problem').allInnerTexts()).toEqual([
			expect.stringContaining('store-front/wrk1'),
			expect.stringContaining('store-api'),
			expect.stringContaining('signals'),
		]);
		expect(await page.locator('.problem.quiet').innerText()).toContain('Set up with Claude');
		expect(
			(await table.locator('tr[data-project="store-api"]').innerText()).toLowerCase(),
		).toContain('check failed');
		expect(await table.locator('tr[data-project="signals"]').innerText()).toContain('Set up');
		// The member column: every workspace the project is in, by name.
		expect(await table.locator('tr[data-project="store-front"] td.m').nth(1).innerText()).toBe(
			'store-front, admin',
		);

		await page.getByRole('tab', { name: 'Workspaces' }).click();
		await page.waitForURL('**/setup/workspaces');
		const row = page.locator('tr[data-workspace="store-front"]');
		await row.waitFor({ timeout: 5000 });
		expect(await row.locator('.srv button.down').innerText()).toContain('wrk1');
		expect(await page.getByRole('button', { name: 'New workspace' }).count()).toBe(1);
		await context.close();
	}, 20_000);

	it("the machine picker: every machine, another one's problems said in the menu", async () => {
		server.store.dispatch({
			type: 'machines',
			machines: [{ id: 'vm1', host: 'dev@vm1', name: 'Build box' }],
		});
		server.store.dispatch({ type: 'machine_resynced', id: 'vm1', inputs: [] });
		const { context, page } = await open('/setup');
		await page.getByRole('button', { name: 'Machine: This Mac' }).click();
		const menu = page.getByRole('menu');

		await menu
			.getByRole('menuitemradio', { name: /Build box/ })
			.getByText('SSH · 2 need you')
			.waitFor({ timeout: 5000 });
		await menu.getByRole('menuitemradio', { name: /Build box/ }).click();
		await page.waitForURL('**/setup?on=vm1');
		expect(await page.locator('h1').innerText()).toBe('Build box');
		await waitUntil(() => server.crew.calls.some((call) => call.machine === 'vm1'));
		server.store.dispatch({ type: 'machines', machines: [] });
		await context.close();
	}, 20_000);

	it('Fix with Claude while setup is busy → "Setup is busy": Queue it sends it to the setup session', async () => {
		server.store.dispatch({ type: 'send', ref: 'setup', text: 'check this machine' });
		await waitUntil(() => server.store.state.sessions.setup?.status === 'running');
		const { context, page } = await open('/setup');
		await page
			.locator('.problem', { hasText: 'store-front/wrk1' })
			.getByRole('button', { name: 'Fix with Claude' })
			.click();
		const dialog = page.getByRole('dialog', { name: 'Setup is busy' });
		await dialog.getByText('store-front/wrk1').waitFor({ timeout: 5000 });

		const before = server.received.length;
		await dialog.getByRole('button', { name: 'Queue it' }).click();
		await waitUntil(() =>
			server.received
				.slice(before)
				.some(
					(entry) =>
						entry.message.type === 'action' &&
						entry.message.action.type === 'send' &&
						entry.message.action.ref === 'setup',
				),
		);
		server.store.dispatch({ type: 'turn_ended', ref: 'setup', costUsd: 0, text: '' });
		await context.close();
	}, 20_000);
});

describe('a project', () => {
	it('the form: a server renamed in place, a new one added; the command line follows; Save runs it and the check decides', async () => {
		const { context, page } = await open('/setup/project/store-api/edit');
		const row = page.locator('.srv-row[data-server="api"]');
		await row.waitFor({ timeout: 5000 });

		await row.getByLabel('name').fill('http');
		await page.getByRole('button', { name: '+ Add server' }).click();
		const added = page.locator('.srv-row[data-server="new"]');
		await added.getByLabel('name').fill('cron');
		await added.getByLabel('command').fill('make cron');
		const runs = page.locator('.runs pre');
		expect(await runs.innerText()).toContain(
			"crew dev add store-api --name=http --rename=api --port=4000 --cmd='make dev'",
		);
		expect(await runs.innerText()).toContain(
			"crew dev add store-api --name=cron --cmd='make cron'",
		);
		expect(await runs.innerText()).toContain('crew check project store-api');

		await page.getByRole('button', { name: 'Save and check' }).click();
		await page.waitForURL('**/setup/project/store-api/check');
		await page.getByText('store-api is ready.').waitFor({ timeout: 10_000 });
		expect(commandsOf('dev_add')).toEqual([
			{
				type: 'dev_add',
				project: 'store-api',
				name: 'http',
				cmd: 'make dev',
				rename: 'api',
				port: 4000,
			},
			{ type: 'dev_add', project: 'store-api', name: 'cron', cmd: 'make cron' },
		]);
		expect(commandsOf('check_project')).toHaveLength(1);
		// store-api is in store-front already: no "Put it in a workspace".
		expect(await page.getByRole('button', { name: 'Put it in a workspace' }).count()).toBe(0);
		await context.close();
	}, 30_000);

	it('never checked → "Check", not "Check again"', async () => {
		const { context, page } = await open('/setup/project/store-front');
		await page.getByText('Set up, not checked yet').waitFor({ timeout: 5000 });

		expect(await page.getByRole('button', { name: 'Check', exact: true }).count()).toBe(1);
		expect(await page.getByRole('button', { name: 'Check again' }).count()).toBe(0);
		await context.close();
	}, 20_000);

	it("the Environment editor: a live preview of what each worktree gets, and crew's own error for a bad template", async () => {
		const { context, page } = await open('/setup/project/store-front/edit');
		await page.getByPlaceholder('API_URL').fill('API_URL');
		const preview = page.locator('.preview');

		await preview.getByText('in store-front/main: API_URL=').waitFor({ timeout: 5000 });
		expect(await preview.innerText()).toContain('http://localhost:54012');
		expect(await preview.innerText()).toContain('store-api is not in this workspace');
		expect(await page.locator('.runs pre').innerText()).toContain(
			'crew add binding store-front --var=API_URL',
		);
		await context.close();
	}, 20_000);

	it('a failed check → the failure block with its steps, the log and the ways out', async () => {
		const { context, page } = await open('/setup/project/store-api');
		const fail = page.locator('.fail');
		await fail.getByText('Check failed').waitFor({ timeout: 5000 });

		expect(await fail.locator('.fail-steps .bad').innerText()).toBe('install');
		expect(await fail.locator('.log').innerText()).toContain('ERR_PNPM_NO_MATCHING_VERSION');

		for (const name of ['Fix with Claude', 'Edit setup', 'Check again', 'Full log']) {
			expect(await fail.getByRole('button', { name }).count()).toBe(1);
		}

		await fail.getByRole('button', { name: 'Full log' }).click();
		const full = page.locator('section[aria-label="Project store-api"] > pre.log');
		await full.getByText('ERR_PNPM_NO_MATCHING_VERSION').waitFor({ timeout: 5000 });
		expect(await full.innerText()).toContain('✓ checkout 0.9s');

		await context.close();
	}, 20_000);
});

describe('worktrees', () => {
	it('new worktree: the bases, then progress read from crew until it is done', async () => {
		const { context, page } = await open('/setup/workspace/store-front/new-worktree');
		await page
			.locator('.bases [data-project="store-front"]')
			.getByText('main · 3 behind')
			.waitFor({ timeout: 5000 });
		await page.getByRole('textbox').first().fill('search');
		expect(await page.locator('.runs pre').innerText()).toContain(
			'crew add worktree store-front/search --pull',
		);

		await page.getByRole('button', { name: 'Create worktree' }).click();
		await page.waitForURL('**/setup/worktree/store-front/search/progress');
		await page.locator('.pg[data-state="wait"]').first().waitFor({ timeout: 5000 });
		await page.getByRole('button', { name: 'Open in Voice OS' }).waitFor({ timeout: 10_000 });
		expect(await page.locator('.pg[data-state="ok"]').count()).toBeGreaterThan(2);
		expect(
			server.crew.calls.filter((call) => call.command.type === 'setup_status').length,
		).toBeGreaterThan(1);
		await context.close();
	}, 30_000);

	it('removal asks first, with what it costs; confirming runs crew rm worktree', async () => {
		const { context, page } = await open('/setup/worktree/store-front/wrk1');
		await page.getByRole('button', { name: 'Remove worktree' }).click();
		const confirm = page.getByRole('dialog', { name: 'Remove store-front/wrk1?' });

		await confirm
			.getByText('3 uncommitted files · 2 commits not on its base')
			.waitFor({ timeout: 5000 });
		await Bun.sleep(300);
		expect(commandsOf('rm_worktree_dry_run')).toHaveLength(1);
		expect(await confirm.getByText('your own checkout: left alone').count()).toBe(1);
		expect(await confirm.locator('.runs pre').innerText()).toBe(
			'crew rm worktree store-front/wrk1',
		);
		expect(commandsOf('rm_worktree')).toEqual([]);

		await confirm.getByRole('button', { name: 'Remove worktree' }).click();
		await page.waitForURL('**/setup/workspace/store-front');
		expect(commandsOf('rm_worktree')).toEqual([
			{ type: 'rm_worktree', ref: 'store-front/wrk1', confirm: true },
		]);
		await context.close();
	}, 20_000);

	it('pinned values: the form shows its command before anything is typed, then the one it runs', async () => {
		const { context, page } = await open('/setup/worktree/store-front/main');
		const form = page.locator('form.ov-add');
		await form.waitFor({ timeout: 5000 });
		const runs = page.locator('form.ov-add + .runs pre');

		expect(await runs.innerText()).toBe('crew add override store-front/main VAR=value');
		await form.getByLabel('Variable and value').fill('STRIPE_KEY=sk_test_1');
		await form.getByLabel('Which project').selectOption('store-api');
		expect(await runs.innerText()).toBe(
			'crew add override store-front/main store-api.STRIPE_KEY=sk_test_1',
		);
		expect(await page.locator('form.ov-add + .runs .label').innerText()).toMatch(/This Mac/i);
		await context.close();
	}, 20_000);

	it("a server's log: crew's clean lines, as text", async () => {
		const { context, page } = await open('/setup/worktree/store-front/main/logs');
		const log = page.locator('pre.log');
		await log.getByText('GET / 200 4 ms').waitFor({ timeout: 5000 });

		expect(await log.innerText()).toBe('$ web\nlistening\nGET / 200 4 ms');
		expect(commandsOf('dev_logs')[0]).toMatchObject({ type: 'dev_logs', server: 'web' });
		await context.close();
	}, 20_000);

	it('Esc goes up one breadcrumb: logs → the worktree → its workspace → the board', async () => {
		const { context, page } = await open('/setup/worktree/store-front/main/logs');
		await page.locator('.crumbs .here', { hasText: 'Logs' }).waitFor({ timeout: 5000 });
		expect(await page.locator('.crumbs').innerText()).toMatch(
			/This Mac\s*›\s*Workspaces\s*›\s*store-front\s*›\s*main\s*›\s*Logs/,
		);

		await page.keyboard.press('Escape');
		await page.waitForURL('**/setup/worktree/store-front/main');
		await page.keyboard.press('Escape');
		await page.waitForURL('**/setup/workspace/store-front');
		await page.keyboard.press('Escape');
		await page.waitForURL('**/setup/workspaces');
		await context.close();
	}, 20_000);

	it('a deep link survives a reload: the same page, on the same machine', async () => {
		const { context, page } = await open('/setup/project/signals');
		await page.locator('h1', { hasText: 'signals' }).waitFor({ timeout: 5000 });
		await page.reload();
		await page.locator('h1', { hasText: 'signals' }).waitFor({ timeout: 5000 });
		expect(new URL(page.url()).pathname).toBe('/setup/project/signals');
		await context.close();
	}, 20_000);
});

describe('Setup with Claude', () => {
	it('the stream as Voice OS draws it, a "✓ recorded" line under each crew command that recorded, questions as answer cards', async () => {
		server.store.dispatch({
			type: 'tool',
			ref: 'setup',
			name: 'Bash',
			summary: 'run crew dev add signals --name=web --port=3000',
		});
		server.store.dispatch({
			type: 'tool_result',
			ref: 'setup',
			ok: true,
			summary: 'Added dev server',
		});
		server.store.dispatch({
			type: 'assistant_text',
			ref: 'setup',
			text: 'The worker needs **REDIS_URL**.',
		});
		server.store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'setup-q1',
				ref: 'setup',
				at: 1,
				kind: 'question',
				input: {},
				questions: [
					{
						question: 'How should the worker reach Redis?',
						header: 'Environment',
						multiSelect: false,
						options: [
							{ label: 'I have Redis on :6379', description: 'Record REDIS_URL' },
							{ label: 'Skip the worker' },
						],
					},
				],
			},
		});
		const { context, page } = await open('/setup/chat');
		await page
			.locator('.rec-line', { hasText: '✓ recorded · Dev server: web :3000' })
			.waitFor({ timeout: 5000 });
		expect(await page.locator('.chat strong', { hasText: 'REDIS_URL' }).count()).toBe(1);
		const card = page.locator('.ask-card');
		expect(await card.getByRole('button', { name: /Something else…/ }).count()).toBe(1);

		await card.getByRole('button', { name: /Something else…/ }).click();
		await page.getByLabel('Reply to setup').fill('use the one in docker compose');
		await page.getByRole('button', { name: 'Answer', exact: true }).click();
		await waitUntil(() => server.store.state.asks.every((ask) => ask.id !== 'setup-q1'));
		const answer = server.received.find(
			(entry) => entry.message.type === 'action' && entry.message.action.type === 'answer_question',
		);
		expect(answer?.message).toMatchObject({
			action: {
				answers: { 'How should the worker reach Redis?': 'use the one in docker compose' },
			},
		});
		await context.close();
	}, 20_000);
});

describe('moving to another machine', () => {
	it("Export… saves crew's bundle as a file; Import reads it back as plan rows and clones a project", async () => {
		const { context, page } = await open('/setup/settings');
		await page.getByRole('button', { name: 'Export…' }).click();
		await page.locator('.export-picks').waitFor({ timeout: 5000 });
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.getByRole('button', { name: 'Export everything' }).click(),
		]);

		expect(download.suggestedFilename()).toBe('crew-export.json');
		expect(commandsOf('export')).toEqual([{ type: 'export', all: true }]);
		const file = await download.path();
		const bundle = JSON.parse(await Bun.file(file).text()) as {
			version: number;
			projects: { name: string; path?: string; remote?: string }[];
			workspaces: { name: string }[];
		};
		expect(bundle.version).toBe(2);
		expect(bundle.projects.map((project) => project.name)).toEqual([
			'store-front',
			'store-api',
			'signals',
		]);
		expect(bundle.projects.every((project) => project.path === undefined)).toBe(true);
		await page.getByText('Wrote the bundle to stdout — 3 projects, 2 workspaces').waitFor({
			timeout: 5000,
		});

		// The other machine: nothing there yet.
		server.crew.reset('empty');
		await page.getByRole('button', { name: 'Import…' }).click();
		await page.waitForURL('**/setup/import');
		await page.getByLabel('Export file').setInputFiles(file);

		const storeApi = page.locator('[data-project="store-api"]');
		await storeApi.getByText('clone into /Users/dev/.crew/projects/store-api').waitFor({
			timeout: 5000,
		});
		expect(await page.locator('[data-project="signals"]').innerText()).toContain(
			'no remote in the export',
		);
		expect(await page.locator('.box-row', { hasText: 'admin' }).innerText()).toContain(
			'needs store-front first',
		);
		const [plan] = commandsOf('import_plan');
		expect(plan && 'bundle' in plan && JSON.parse(plan.bundle).version).toBe(2);

		await storeApi.getByRole('button', { name: 'Clone' }).click();
		await storeApi.getByText('already here').waitFor({ timeout: 5000 });
		expect(
			commandsOf('import_project').map((command) => 'name' in command && command.name),
		).toEqual(['store-api']);
		expect(server.crew.machines.local?.projects.map((project) => project.name)).toEqual([
			'store-api',
		]);
		await context.close();
	}, 20_000);
});

describe('first run', () => {
	it('pick checkouts → a workspace → an install fails → Retry → Open Voice OS on its session', async () => {
		server.crew.reset('empty');
		server.crew.failInstall('infra-ops');
		const { context, page } = await open('/setup');
		const welcome = page.locator('section[aria-label="Set up This Mac"]');
		await welcome.getByText('Pick your projects', { exact: true }).waitFor({ timeout: 5000 });
		await welcome.locator('[data-checkout="checkout-api"]').waitFor({ timeout: 5000 });

		await welcome.getByRole('button', { name: 'Add 3 projects' }).click();
		await welcome
			.getByText('3 added: store-front, checkout-api, infra-ops')
			.waitFor({ timeout: 5000 });
		expect(commandsOf('add_project').map((command) => 'name' in command && command.name)).toEqual([
			'store-front',
			'checkout-api',
			'infra-ops',
		]);

		await welcome.getByRole('checkbox', { name: /infra-ops/ }).check();
		expect(await welcome.locator('.runs pre').innerText()).toContain(
			'crew add workspace store-front store-front infra-ops',
		);
		await welcome.getByRole('button', { name: 'Create workspace' }).click();

		const fail = welcome.locator('.fail');
		await fail.getByText(/infra-ops: install failed/).waitFor({ timeout: 10_000 });
		await fail.getByRole('button', { name: 'Retry' }).click();
		await fail.waitFor({ state: 'detached', timeout: 10_000 });
		await welcome.getByText('store-front/main is ready.').waitFor({ timeout: 10_000 });
		expect(commandsOf('setup_rerun')).toEqual([
			{ type: 'setup_rerun', ref: 'store-front/main', projects: ['infra-ops'] },
		]);

		await welcome.getByRole('button', { name: 'Open Voice OS' }).click();
		await page.waitForURL('**/voice/session/store-front/main');
		await waitUntil(() => server.store.state.active.includes('store-front/main'));
		server.store.dispatch({ type: 'deactivate', ref: 'store-front/main' });
		await context.close();
	}, 40_000);

	it('Open Voice OS on a worktree Voice OS has not listed yet → it is read at once, activated and shown', async () => {
		server.crew.reset('empty');
		const { context, page } = await open('/setup');
		const welcome = page.locator('section[aria-label="Set up This Mac"]');
		await welcome.locator('[data-checkout="checkout-api"]').waitFor({ timeout: 5000 });
		await welcome.getByRole('button', { name: 'Add 3 projects' }).click();
		await welcome.getByRole('textbox', { name: 'Workspace name' }).waitFor({ timeout: 5000 });
		await welcome.getByRole('textbox', { name: 'Workspace name' }).fill('checkout-api');
		await welcome.getByRole('button', { name: 'Create workspace' }).click();
		await welcome.getByText('checkout-api/main is ready.').waitFor({ timeout: 10_000 });
		expect(server.store.state.sessions['checkout-api/main']).toBeUndefined();
		// As live: the page's switch to the session lands before crew's list has it, so only the
		// held activation's open can show it.
		server.latency.worktreesMs = 400;

		await welcome.getByRole('button', { name: 'Open Voice OS' }).click();
		await page.waitForURL('**/voice/session/checkout-api/main');
		await waitUntil(
			() =>
				server.store.state.view.kind === 'session' &&
				server.store.state.view.ref === 'checkout-api/main',
		);
		expect(server.store.state.active).toContain('checkout-api/main');
		await page
			.locator('.vo-tab[data-ref="checkout-api/main"][aria-current="true"]')
			.waitFor({ timeout: 5000 });

		server.latency.worktreesMs = 0;
		server.store.dispatch({ type: 'deactivate', ref: 'checkout-api/main' });
		server.store.dispatch({
			type: 'worktrees',
			worktrees: [createWorktree('setup', true), createWorktree('store-front/main')],
		});
		server.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		await context.close();
	}, 40_000);

	it('Home on a first run: Voice OS greyed with why, Set up marked "start here"', async () => {
		server.crew.reset('empty');
		const { context, page } = await open('/');
		const voice = page.locator('.launch-choice', { hasText: 'Voice OS' });
		await voice.getByText('Add a project first').waitFor({ timeout: 5000 });

		expect(await voice.isDisabled()).toBe(true);
		expect(await page.locator('.launch-choice.last').innerText()).toContain('start here');
		expect(await page.getByText('Always open Voice OS').count()).toBe(0);
		await context.close();
	}, 20_000);
});

interface RemovalCase {
	name: string;
	path: string;
	// Puts the fake crew where the removal is allowed.
	arrange?: () => void;
	// The button (or its label) that opens the confirm.
	open: (page: Page) => Promise<void>;
	dialog: string;
	// What it costs, said before anything runs.
	cost: string;
	type: SetupCommand['type'];
	command: SetupCommand;
	action: string;
	typed?: string;
	after: (page: Page) => Promise<void>;
}

const writeBundle = (): string => {
	const file = join(mkdtempSync(join(tmpdir(), 'voiceos-bundle-')), 'crew-export.json');

	writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			projects: [{ name: 'store-front', remote: 'git@github.com:example/store-front.git' }],
			workspaces: [],
		}),
	);

	return file;
};

const REMOVALS: RemovalCase[] = [
	{
		name: 'rm project',
		path: '/setup/project/signals',
		arrange: () => {
			for (const workspace of server.crew.machines.local?.workspaces ?? []) {
				workspace.projects = workspace.projects.filter((member) => member.name !== 'signals');
			}
		},
		open: (page) => page.getByRole('button', { name: 'Remove project' }).click(),
		dialog: 'Remove signals from This Mac?',
		cost: 'A checkout crew cloned goes to the trash',
		type: 'rm_project',
		command: { type: 'rm_project', name: 'signals', confirm: true },
		action: 'Remove project',
		after: (page) => page.waitForURL('**/setup'),
	},
	{
		name: 'rm workspace <p>',
		path: '/setup/workspace/store-front',
		open: (page) => page.getByLabel('Take store-api out of store-front').click(),
		dialog: 'Take store-api out of store-front?',
		cost: '1 uncommitted file',
		type: 'rm_workspace_project',
		command: {
			type: 'rm_workspace_project',
			workspace: 'store-front',
			project: 'store-api',
			confirm: true,
		},
		action: 'Take it out',
		after: (page) =>
			page.getByRole('dialog', { name: 'Take store-api out of store-front?' }).waitFor({
				state: 'detached',
			}),
	},
	{
		name: "the workspace's last worktree",
		path: '/setup/worktree/admin/main',
		open: (page) => page.getByRole('button', { name: 'Remove worktree' }).click(),
		dialog: 'Remove admin/main and the admin workspace?',
		cost: 'admin/main · store-front',
		type: 'rm_workspace',
		command: { type: 'rm_workspace', workspace: 'admin', confirm: true },
		action: 'Remove worktree',
		after: (page) => page.waitForURL('**/setup/workspaces'),
	},
	{
		name: 'trash empty',
		path: '/setup/settings',
		open: (page) => page.getByRole('button', { name: 'Empty now' }).click(),
		dialog: 'Empty the trash?',
		cost: 'deleted for good',
		type: 'trash_empty',
		command: { type: 'trash_empty', confirm: true },
		action: 'Empty the trash',
		after: (page) => page.getByText('empty', { exact: true }).waitFor(),
	},
	{
		name: 'clean',
		path: '/setup/settings',
		open: (page) => page.getByRole('button', { name: 'Clean up' }).click(),
		dialog: "Clean up what's left behind?",
		cost: 'an old check: /Users/dev/.crew/checks/store-api.json',
		type: 'clean',
		command: { type: 'clean', confirm: true },
		action: 'Clean up',
		after: (page) =>
			page.getByRole('dialog', { name: "Clean up what's left behind?" }).waitFor({
				state: 'detached',
			}),
	},
	{
		name: 'import --replace',
		path: '/setup/import',
		open: async (page) => {
			await page.getByLabel('Export file').setInputFiles(writeBundle());
			await page
				.locator('[data-project="store-front"]')
				.getByRole('button', { name: 'Replace config' })
				.click();
		},
		dialog: "Replace this project's config with the export's?",
		cost: 'Its checkout and worktrees stay',
		type: 'import_project',
		command: {
			type: 'import_project',
			bundle: '',
			name: 'store-front',
			replace: true,
			confirm: true,
		},
		action: 'Replace',
		after: (page) =>
			page
				.getByRole('dialog', { name: "Replace this project's config with the export's?" })
				.waitFor({
					state: 'detached',
				}),
	},
	{
		name: 'uninstall (keep)',
		path: '/setup/settings',
		open: (page) => page.getByRole('button', { name: 'Uninstall crew…' }).click(),
		dialog: 'Uninstall crew?',
		cost: '~/.crew stays',
		type: 'uninstall',
		command: { type: 'uninstall', mode: 'keep', confirm: true },
		action: 'Uninstall',
		typed: 'uninstall',
		after: (page) => page.locator('h1', { hasText: 'crew is uninstalled' }).waitFor(),
	},
];

describe('every removal asks first, with what it costs', () => {
	it.each(REMOVALS.map((removal) => [removal.name, removal] as const))(
		'%s: the cost shows, nothing runs before the confirm, then exactly its command',
		async (_, removal) => {
			removal.arrange?.();
			const { context, page } = await open(removal.path);
			await removal.open(page);
			const dialog = page.getByRole('dialog', { name: removal.dialog });

			await dialog.getByText(removal.cost).first().waitFor({ timeout: 5000 });
			expect(commandsOf(removal.type)).toEqual([]);
			// One click, one dry run: the page and its dialog share the read, a re-render never repeats it.
			await Bun.sleep(300);
			const dryRuns = server.crew.calls
				.map((call) => call.command)
				.filter((command) => command.type.endsWith('_dry_run'))
				.map((command) => JSON.stringify(command));
			expect(dryRuns.length).toBe(new Set(dryRuns).size);

			const confirm = dialog.getByRole('button', { name: removal.action, exact: true });

			if (removal.typed) {
				expect(await confirm.isDisabled()).toBe(true);
				await dialog.getByLabel(`Type ${removal.typed} to confirm`).fill(removal.typed);
			}

			await confirm.click();
			await removal.after(page);

			const ran = commandsOf(removal.type);

			expect(ran).toHaveLength(1);
			expect(
				ran.map((command) => ('bundle' in command ? { ...command, bundle: '' } : command)),
			).toEqual([removal.command]);
			await context.close();
		},
		20_000,
	);
});

describe("another machine's crew, when it cannot answer", () => {
	const VM1 = { id: 'vm1', host: 'dev@vm1', name: 'Build box' };

	afterEach(() => {
		server.store.dispatch({ type: 'machines', machines: [] });
	});

	it.each([
		[
			'an older release',
			{ reason: 'remote_outdated' as const, version: '4.1.0' },
			'vm1 runs an older crew that cannot do this yet — it updates from this Mac (it runs crew 4.1.0)',
		],
		['out of reach', { reason: 'offline' as const }, 'vm1 is out of reach'],
	])(
		'%s → the board says so, in words',
		async (_, failure, line) => {
			server.store.dispatch({ type: 'machines', machines: [VM1] });
			server.crew.failMachine('vm1', failure);
			const { context, page } = await open('/setup?on=vm1');

			await page.locator('.result-line.bad', { hasText: line }).waitFor({ timeout: 5000 });
			await context.close();
		},
		20_000,
	);
});

describe('machines and settings', () => {
	const VM1 = { id: 'vm1', host: 'dev@vm1', name: 'Build box' };

	afterEach(() => {
		server.store.dispatch({ type: 'machines', machines: [] });
	});

	it('a machine renamed, then removed: each its command, run on this Mac', async () => {
		server.store.dispatch({ type: 'machines', machines: [VM1] });
		const { context, page } = await open('/setup/machine?on=vm1');
		await page.getByRole('button', { name: 'Rename' }).click();
		await page.getByLabel('Machine name').fill('Build server');
		expect(await page.locator('.runs pre').innerText()).toContain(
			"crew server machines rename vm1 'Build server'",
		);
		await page.locator('form.inline-form').getByRole('button', { name: 'Rename' }).click();
		await waitUntil(() => commandsOf('machines_rename').length === 1);
		expect(commandsOf('machines_rename')).toEqual([
			{ type: 'machines_rename', id: 'vm1', name: 'Build server' },
		]);
		expect(server.crew.calls.find((call) => call.command.type === 'machines_rename')?.machine).toBe(
			'local',
		);
		expect(server.crew.machines.local?.voiceMachines.find((row) => row.id === 'vm1')?.name).toBe(
			'Build server',
		);

		await page.getByRole('button', { name: 'Remove machine' }).click();
		const dialog = page.getByRole('dialog', { name: 'Remove Build box?' });
		await dialog.getByText('Nothing on the machine is deleted').waitFor({ timeout: 5000 });
		expect(commandsOf('machines_rm')).toEqual([]);
		await dialog.getByRole('button', { name: 'Remove machine' }).click();
		await page.waitForURL('**/setup?on=vm1');
		expect(commandsOf('machines_rm')).toEqual([{ type: 'machines_rm', id: 'vm1', confirm: true }]);
		await context.close();
	}, 20_000);

	it("a remote machine's settings → no Update and no uninstall, and no update check anywhere", async () => {
		server.store.dispatch({ type: 'machines', machines: [VM1] });
		const { context, page } = await open('/setup/settings?on=vm1');
		await page.getByText('crew on Build box.').waitFor({ timeout: 5000 });
		await waitUntil(() =>
			server.crew.calls.some(
				(call) => call.machine === 'vm1' && call.command.type === 'config_show',
			),
		);
		expect(await page.getByRole('button', { name: 'Update', exact: true }).count()).toBe(0);
		expect(await page.getByRole('button', { name: 'Uninstall crew…' }).count()).toBe(0);
		expect(server.crew.calls.filter((call) => call.command.type === 'update_check')).toEqual([]);
		await context.close();
	}, 20_000);

	it('workspaces from before crew 2.0 → Migrate, with its plan; gone once moved', async () => {
		const local = server.crew.machines.local;

		if (local) {
			local.flatWorkspaces = ['legacy'];
		}

		const { context, page } = await open('/setup/settings');
		await page.getByText('1 workspace has the flat layout').waitFor({ timeout: 5000 });
		await page.getByRole('button', { name: 'Migrate', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Migrate to worktrees?' });
		await dialog.getByText('legacy: ~/.crew/workspaces/legacy → legacy/main').waitFor({
			timeout: 5000,
		});
		expect(commandsOf('migrate')).toEqual([]);

		await dialog.getByRole('button', { name: 'Migrate' }).click();
		await page.getByText('1 workspace has the flat layout').waitFor({
			state: 'detached',
			timeout: 5000,
		});
		expect(commandsOf('migrate')).toEqual([{ type: 'migrate', confirm: true }]);
		await context.close();
	}, 20_000);

	it("this machine's fields → config set for what changed; trust → what the other device opens", async () => {
		const { context, page } = await open('/setup/settings');
		const ip = page.getByRole('textbox', { name: 'Server IP' });
		await expect(ip.inputValue()).resolves.toBeDefined();
		await page.waitForFunction(
			() =>
				(document.querySelector('.cfg-grid input') as HTMLInputElement | null)?.value ===
				'192.168.1.20',
		);
		// A port at its default reads empty, the placeholder says which; a set one reads as set.
		const https = page.getByRole('textbox', { name: 'HTTPS port' });
		expect(await https.inputValue()).toBe('');
		expect(await https.getAttribute('placeholder')).toBe('443 (default)');
		expect(await page.getByRole('textbox', { name: 'HTTP port' }).inputValue()).toBe('80');
		await ip.fill('10.0.0.9');
		expect(await page.locator('.cfg-sec .runs pre').first().innerText()).toBe(
			'crew config set server_ip 10.0.0.9',
		);
		await page.getByRole('button', { name: 'Save' }).click();
		await waitUntil(() => commandsOf('config_set').length === 1);
		expect(commandsOf('config_set')).toEqual([
			{ type: 'config_set', key: 'server_ip', value: '10.0.0.9' },
		]);

		await page.getByRole('button', { name: 'Trust on other devices' }).click();
		await page
			.getByText('On the other device, open http://192.168.1.20/crew-ca.pem')
			.waitFor({ timeout: 5000 });
		expect(commandsOf('proxy_trust')).toEqual([{ type: 'proxy_trust' }]);
		await context.close();
	}, 20_000);

	// crew clean lists one prune row per pool repo whether or not git has anything to prune, so
	// those rows never make Left behind say there is something to clear.
	const leftBehind = (page: Page) =>
		page.locator('.box-row').filter({ has: page.locator('b', { hasText: 'Left behind' }) });

	it('only prune rows → Left behind has nothing to clear, Clean up is off', async () => {
		const local = server.crew.machines.local;

		if (local) {
			local.cleanDryRun = [
				{ kind: 'prune', path: '/Users/dev/.crew/projects/store-api', removed: false },
				{ kind: 'prune', path: '/Users/dev/code/store-front', removed: false },
			];
		}

		const { context, page } = await open('/setup/settings');
		await waitUntil(() => commandsOf('clean_dry_run').length > 0);
		await leftBehind(page).getByText('nothing to clear').waitFor({ timeout: 5000 });
		expect(await leftBehind(page).getByRole('button', { name: 'Clean up' }).isDisabled()).toBe(
			true,
		);
		await context.close();
	}, 20_000);

	it('prune rows beside a check → one thing to clear, and the confirm lists only the check', async () => {
		const local = server.crew.machines.local;

		if (local) {
			local.cleanDryRun = [
				{ kind: 'prune', path: '/Users/dev/.crew/projects/store-api', removed: false },
				{ kind: 'check', path: '/Users/dev/.crew/checks/store-api.json', removed: false },
				{ kind: 'prune', path: '/Users/dev/code/store-front', removed: false },
			];
		}

		const { context, page } = await open('/setup/settings');
		await leftBehind(page).getByText('1 thing crew can clear').waitFor({ timeout: 5000 });
		await leftBehind(page).getByRole('button', { name: 'Clean up' }).click();
		const dialog = page.getByRole('dialog', { name: "Clean up what's left behind?" });
		await dialog.locator('ul.cost li').first().waitFor({ timeout: 5000 });
		expect(await dialog.locator('ul.cost li').allInnerTexts()).toEqual([
			'an old check: /Users/dev/.crew/checks/store-api.json',
		]);
		expect(commandsOf('clean')).toEqual([]);
		await context.close();
	}, 20_000);

	it("a new release → Update → Restart crew's server", async () => {
		const { context, page } = await open('/setup/settings');
		await page.getByText('crew 4.2.0 is out').waitFor({ timeout: 5000 });
		await page.getByRole('button', { name: 'Update', exact: true }).click();
		await page.getByText('crew 4.2.0 is installed').waitFor({ timeout: 5000 });
		await page.getByRole('button', { name: "Restart crew's server" }).click();
		await waitUntil(() => commandsOf('server_restart').length === 1);
		expect(commandsOf('update')).toEqual([{ type: 'update' }]);
		expect(server.crew.calls.every((call) => call.machine === 'local')).toBe(true);
		await context.close();
	}, 20_000);
});

describe('"Always open Voice OS"', () => {
	const ALWAYS = { 'crew.alwaysVoice': '1' };

	// Voice OS opens on whatever screen every tab shows: Active, for these.
	beforeEach(() => {
		server.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
	});

	afterEach(() => {
		server.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
	});

	it('a fresh load of / → Voice OS; the crew mark still shows Home', async () => {
		const { context, page } = await open('/', undefined, ALWAYS);
		await page.waitForURL((url) => url.pathname.startsWith('/voice'), { timeout: 5000 });
		await page.getByRole('button', { name: 'crew voice os' }).click();
		await page.waitForURL((url) => url.pathname === '/');
		await page.locator('main[aria-label="Home"]').waitFor({ timeout: 5000 });
		await Bun.sleep(300);
		expect(new URL(page.url()).pathname).toBe('/');
		await context.close();
	}, 20_000);

	it('a link to Set up → Set up, never redirected', async () => {
		const { context, page } = await open('/setup', undefined, ALWAYS);
		await page.locator('.matrix').waitFor({ timeout: 5000 });
		await Bun.sleep(300);
		expect(new URL(page.url()).pathname).toBe('/setup');
		await context.close();
	}, 20_000);

	it('a first run → Home stays: Voice OS is greyed until there is a worktree', async () => {
		server.crew.reset('empty');
		const { context, page } = await open('/', undefined, ALWAYS);
		await page.getByText('Add a project first').waitFor({ timeout: 5000 });
		await Bun.sleep(300);
		expect(new URL(page.url()).pathname).toBe('/');
		await context.close();
	}, 20_000);

	it("turned off in Voice OS's settings → / is Home again", async () => {
		const { context, page } = await open('/', undefined, ALWAYS);
		await page.waitForURL((url) => url.pathname.startsWith('/voice'), { timeout: 5000 });
		await page.getByRole('button', { name: 'Voice OS settings' }).click();
		const toggle = page.getByRole('checkbox', { name: /Always open Voice OS/ });
		expect(await toggle.isChecked()).toBe(true);
		await toggle.uncheck();
		expect(await page.evaluate(() => localStorage.getItem('crew.alwaysVoice'))).toBe('0');
		await context.close();

		// A new browser profile would forget it: the same one, opened again, keeps Home.
		const again = await open('/', undefined, { 'crew.alwaysVoice': '0' });
		await again.page.locator('main[aria-label="Home"]').waitFor({ timeout: 5000 });
		await Bun.sleep(300);
		expect(new URL(again.page.url()).pathname).toBe('/');
		await again.context.close();
	}, 20_000);
});

describe('at phone width', () => {
	it('the board fits 390 wide: the table scrolls inside its box, the page never sideways', async () => {
		const { context, page } = await open('/setup', { width: 390, height: 844 });
		await page.locator('tr[data-project="store-api"]').waitFor({ timeout: 5000 });

		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
		expect(
			await page
				.locator('.matrix-wrap')
				.evaluate((element) => element.scrollWidth > element.clientWidth),
		).toBe(true);
		await context.close();
	}, 20_000);
});
