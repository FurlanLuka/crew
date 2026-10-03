// Set up in a real browser: the real page and gateway, a store the test drives, and the fake crew
// (crew's own JSON shapes from voiceos/testdata/) behind /api/crew.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
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
		// Failures only: signals has no dev servers, and that is a whole project, not a problem.
		expect(await page.locator('.problem').allInnerTexts()).toEqual([
			expect.stringContaining('store-front/wrk1'),
			expect.stringContaining('store-api'),
		]);
		expect(
			(await table.locator('tr[data-project="store-api"]').innerText()).toLowerCase(),
		).toContain('check failed');
		const signals = table.locator('tr[data-project="signals"]');
		await signals.getByRole('button', { name: 'Check', exact: true }).waitFor({ timeout: 5000 });
		const board = (await page.locator('section[aria-label="Board"]').innerText()).toLowerCase();

		for (const words of ['not set up', 'set up yet', 'dev servers yet', 'no dev servers']) {
			expect(board).not.toContain(words);
		}

		expect(await page.locator('.lead').innerText()).toBe(
			'3 projects in 2 workspaces. 2 things need you.',
		);
		expect(await signals.getByRole('button', { name: /Set up/ }).count()).toBe(0);
		// The member column: the first workspace, "+N" for the rest, every one in the title.
		const members = table.locator('tr[data-project="store-front"] td.m').nth(1);
		expect(await members.innerText()).toBe('store-front +1');
		expect(await members.getAttribute('title')).toBe('store-front, admin');

		await page.getByRole('tab', { name: 'Workspaces' }).click();
		await page.waitForURL('**/setup/workspaces');
		const row = page.locator('tr[data-workspace="store-front"]');
		await row.waitFor({ timeout: 5000 });
		expect(await row.locator('.srv button.down').innerText()).toContain('wrk1');
		expect(await page.getByRole('button', { name: 'New workspace' }).count()).toBe(1);
		await context.close();
	}, 20_000);

	it('every row is one line, at 1440 and 1024: a long install, four servers, three workspaces', async () => {
		const local = server.crew.machines.local;

		if (!local) {
			throw new Error('no local machine in the fake crew');
		}

		local.projects.push({
			name: 'checkout-api-with-a-rather-long-name',
			path: '/Users/dev/code/checkout-api',
			setup:
				'pnpm install --frozen-lockfile && pnpm --filter @store/checkout-api run codegen && pnpm build:deps',
			dev_servers: [
				{ name: 'api', port: 4100, command: 'pnpm dev' },
				{ name: 'worker', port: 4101, command: 'pnpm worker' },
				{ name: 'webhooks', port: 4102, command: 'pnpm webhooks' },
				{ name: 'scheduler', port: 4103, command: 'pnpm scheduler' },
			],
			remote: 'git@github.com:example/checkout-api.git',
		});
		local.workspaces.push({ name: 'payments', projects: [], worktrees: ['main'] });

		for (const workspace of local.workspaces) {
			workspace.projects.push({ name: 'checkout-api-with-a-rather-long-name', mode: 'worktree' });
		}

		for (const viewport of [
			{ width: 1440, height: 900 },
			{ width: 1024, height: 768 },
		]) {
			const { context, page } = await open('/setup', viewport);
			const table = page.locator('.matrix');
			const long = table.locator('tr[data-project="checkout-api-with-a-rather-long-name"]');
			await long.getByRole('button', { name: 'Check', exact: true }).waitFor({ timeout: 5000 });
			await table.locator('tr[data-project="store-api"] .chip.ask').waitFor({ timeout: 5000 });

			expect(await long.locator('td').nth(2).innerText()).toBe('api :4100 · worker :4101 +2');
			expect(await long.locator('td').nth(3).innerText()).toBe('store-front +2');
			const heights = await table
				.locator('tbody tr')
				.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
			// A one-line row: what the plainest project (signals) takes.
			const oneLine = await table
				.locator('tr[data-project="signals"]')
				.evaluate((row) => row.getBoundingClientRect().height);

			expect(heights.map((height) => Math.round(height))).toEqual(
				heights.map(() => Math.round(oneLine)),
			);
			expect(oneLine).toBeLessThan(56);

			await page.getByRole('tab', { name: 'Workspaces' }).click();
			await page.locator('tr[data-workspace="payments"]').waitFor({ timeout: 5000 });
			const workspaceHeights = await table
				.locator('tbody tr')
				.evaluateAll((rows) => rows.map((row) => Math.round(row.getBoundingClientRect().height)));

			expect(new Set(workspaceHeights).size).toBe(1);
			await context.close();
		}
	}, 30_000);

	it('a whole row opens its page; a control inside it does only its own thing', async () => {
		const { context, page } = await open('/setup');
		const row = page.locator('tr[data-project="store-front"]');
		await row.waitFor({ timeout: 5000 });

		await row.locator('td').nth(1).click();
		await page.waitForURL('**/setup/project/store-front');
		await page.goBack();
		await page
			.locator('tr[data-project="signals"]')
			.getByRole('button', { name: 'Check', exact: true })
			.click();
		await page.waitForURL('**/setup/project/signals/check');

		await page.goto(server.url('/setup/workspaces'));
		const pill = page.locator('tr[data-workspace="admin"] .srv button', { hasText: 'main' });
		await pill.click();
		await page.waitForURL('**/setup/worktree/admin/main');
		await page.goBack();
		await page.locator('tr[data-workspace="admin"] td').nth(1).click();
		await page.waitForURL('**/setup/workspace/admin');

		const member = page.locator('[data-project="store-front"].row-link');
		await member.getByRole('button', { name: /Take store-front out/ }).click();
		await page
			.getByRole('dialog', { name: 'Take store-front out of admin?' })
			.waitFor({ timeout: 5000 });
		expect(page.url()).toContain('/setup/workspace/admin');
		// Anywhere else on the row: its name's button covers it.
		const note = await member.locator('.m').boundingBox();
		await page.mouse.click((note?.x ?? 0) + 4, (note?.y ?? 0) + 4);
		await page.waitForURL('**/setup/project/store-front');
		await context.close();
	}, 20_000);

	it('every select: no native arrow, a chevron 12px in from the right, the text clear of it', async () => {
		const styleOf = (page: Page) =>
			page.locator('select').evaluateAll((selects) =>
				selects.map((select) => {
					const style = getComputedStyle(select);

					return {
						appearance: style.appearance,
						paddingRight: style.paddingRight,
						position: style.backgroundPosition,
						hasChevron: style.backgroundImage.startsWith('url('),
					};
				}),
			);
		const want = {
			appearance: 'none',
			paddingRight: '32px',
			position: 'calc(100% - 12px) 50%',
			hasChevron: true,
		};

		for (const path of ['/setup/project/store-front/edit', '/setup/worktree/store-front/main']) {
			const { context, page } = await open(path);
			await page.locator('select').first().waitFor({ timeout: 5000 });
			const styles = await styleOf(page);

			expect(styles.length).toBeGreaterThan(0);
			expect(styles).toEqual(styles.map(() => want));
			await context.close();
		}
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

	it('the check page: title and lead outside, the steps and the command in one box', async () => {
		const { context, page } = await open('/setup/project/store-front/check');
		const box = page.locator('.progress-box');
		await box.locator('.pg[data-state="wait"]').first().waitFor({ timeout: 5000 });

		const layout = await page.evaluate(() => {
			const section = document.querySelector('section[aria-label="Checking store-front"]');

			return {
				outside: [...(section?.children ?? [])].map((child) => child.className),
				lastInBox: document.querySelector('.progress-box')?.lastElementChild?.className,
				rowCells: document.querySelector('.progress-box .pg')?.children.length,
			};
		});
		expect(layout).toEqual({
			outside: ['head-row', 'box progress-box'],
			lastInBox: 'runs',
			rowCells: 3,
		});
		expect(await box.locator('.runs pre').innerText()).toBe('crew check project store-front');
		await page.getByText('store-front is ready.').waitFor({ timeout: 10_000 });
		expect(await box.locator('.pg[data-state="ok"]').count()).toBeGreaterThan(1);
		await context.close();
	}, 20_000);

	it('never checked → "Check", not "Check again"', async () => {
		const { context, page } = await open('/setup/project/store-front');
		await page.getByText('Not checked yet').waitFor({ timeout: 5000 });

		expect(await page.getByRole('button', { name: 'Check', exact: true }).count()).toBe(1);
		expect(await page.getByRole('button', { name: 'Check again' }).count()).toBe(0);
		await context.close();
	}, 20_000);

	it('what crew recorded, one line per fact, long values cut with the whole in the title; no .env suggestions', async () => {
		const project = server.crew.machines.local?.projects.find((row) => row.name === 'store-front');

		if (!project) {
			throw new Error('no store-front in the fake crew');
		}

		project.setup = `pnpm install --frozen-lockfile && ${'pnpm run codegen && '.repeat(6)}pnpm build`;
		project.env_cmd = `op inject -i .env.template -o .env --account ${'x'.repeat(80)}`;
		project.dev_servers = [
			...(project.dev_servers ?? []),
			{ name: 'storybook', port: 6006, command: `pnpm storybook --ci ${'--flag '.repeat(30)}` },
		];
		project.bindings = [
			...(project.bindings ?? []),
			{ var: 'PUBLIC_ASSETS_URL', value: `https://cdn.example.com/${'assets/'.repeat(30)}` },
		];

		for (const viewport of [
			{ width: 1440, height: 900 },
			{ width: 1024, height: 768 },
		]) {
			const { context, page } = await open('/setup/project/store-front', viewport);
			const facts = page.locator('table[aria-label="What crew recorded"]');
			await facts.locator('tr[data-fact="install"]').waitFor({ timeout: 5000 });

			expect(await facts.locator('th').allInnerTexts()).toEqual([
				'Install',
				'Env command',
				'Dev server',
				'Dev server',
				'Environment',
				'Environment',
				'Environment',
				'Workspaces',
				'Source',
				'Path',
			]);
			expect(await facts.locator('tr[data-fact="install"] td').getAttribute('title')).toBe(
				project.setup,
			);
			const heights = await facts
				.locator('tr')
				.evaluateAll((rows) => rows.map((row) => Math.round(row.getBoundingClientRect().height)));

			expect(new Set(heights).size).toBe(1);
			expect(heights[0]).toBeLessThan(56);
			expect(await page.getByText('Found in .env').count()).toBe(0);
			expect(await page.getByRole('button', { name: 'Add all' }).count()).toBe(0);
			await context.close();
		}

		const { context, page } = await open('/setup/project/store-front/edit');
		await page.getByPlaceholder('API_URL').waitFor({ timeout: 5000 });
		expect(await page.getByText('Found in .env').count()).toBe(0);
		expect(await page.getByRole('button', { name: 'Use' }).count()).toBe(0);
		expect(commandsOf('add_binding_scan')).toEqual([]);
		await context.close();
	}, 30_000);

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
		expect(await page.locator('.progress-box .pg[data-state="ok"]').count()).toBeGreaterThan(2);
		expect(await page.locator('.progress-box > .runs').count()).toBe(1);
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

	it('Environment: values set for this worktree say what they replace; the form shows its command, then the one it runs', async () => {
		const { context, page } = await open('/setup/worktree/store-front/main');
		const form = page.getByRole('form', { name: 'Set a value for this worktree' });
		await form.waitFor({ timeout: 5000 });
		const runs = page.locator('form.ov-add + .runs pre');
		const override = page.locator('[data-override="STORE_API_URL"]');
		await override.waitFor({ timeout: 5000 });

		expect(await override.innerText()).toContain('set for this worktree');
		expect(await override.innerText()).toContain(
			"instead of store-front's value: store-api api's URL",
		);
		expect(await page.locator('.label', { hasText: 'Environment' }).count()).toBe(1);
		expect((await page.locator('section.page').innerText()).toLowerCase()).not.toContain('pinned');

		expect(await runs.innerText()).toBe('crew add override store-front/main VAR=value');
		await form.getByLabel('Variable and value').fill('STRIPE_KEY=sk_test_1');
		await form.getByLabel('Which project').selectOption('store-api');
		expect(await runs.innerText()).toBe(
			'crew add override store-front/main store-api.STRIPE_KEY=sk_test_1',
		);
		expect(await page.locator('form.ov-add + .runs .label').innerText()).toMatch(/This Mac/i);
		await context.close();
	}, 20_000);

	it('the header: rename and duplicate beside the name, Open in Voice OS alone on the right; server actions in Dev servers', async () => {
		const { context, page } = await open('/setup/worktree/store-front/main');
		const title = page.locator('.title-row');
		await title.getByRole('button', { name: 'Rename' }).waitFor({ timeout: 5000 });

		expect(await title.locator('h1').innerText()).toBe('store-front/main');
		expect(await title.getByRole('button', { name: 'Duplicate' }).getAttribute('title')).toBe(
			'Duplicate',
		);
		expect(await page.locator('.head-row > .row-actions button').allInnerTexts()).toEqual([
			'Open in Voice OS',
		]);
		const servers = page.getByRole('region', { name: 'Dev servers' });
		const actions = servers.locator('.section-head button');
		await servers.getByRole('button', { name: 'Verify' }).waitFor({ timeout: 5000 });

		expect(await actions.allInnerTexts()).toEqual(['Stop servers', 'Restart', 'Verify', 'Logs']);

		await title.getByRole('button', { name: 'Rename' }).click();
		await page.waitForURL('**/setup/worktree/store-front/main/rename');
		await page.goBack();
		await page.locator('.title-row').getByRole('button', { name: 'Duplicate' }).click();
		await page.waitForURL('**/setup/worktree/store-front/main/duplicate');
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
	const REDIS = 'How should the worker reach Redis?';

	const openQuestion = (id: string): void => {
		server.store.dispatch({
			type: 'ask_opened',
			ask: {
				id,
				ref: 'setup',
				at: 1,
				kind: 'question',
				input: {},
				questions: [
					{
						question: REDIS,
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
	};

	const answerOf = (askId: string) =>
		server.received.find(
			(entry) =>
				entry.message.type === 'action' &&
				(entry.message.action.type === 'answer_question' ||
					entry.message.action.type === 'decline_question') &&
				entry.message.action.askId === askId,
		)?.message;

	// Back to idle with nothing queued, for the next test.
	const settle = async (): Promise<void> => {
		for (let turn = 0; turn < 5 && server.store.state.sessions.setup?.status !== 'idle'; turn++) {
			server.store.dispatch({ type: 'turn_ended', ref: 'setup', costUsd: 0, text: '' });
		}

		await waitUntil(() => server.store.state.sessions.setup?.status === 'idle');
	};

	afterEach(settle);

	it('the stream as Voice OS draws it, a "✓ recorded" line under each crew command that recorded, its question docked above the composer', async () => {
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
		openQuestion('setup-q1');
		const { context, page } = await open('/setup/chat');
		await page
			.locator('.rec-line', { hasText: '✓ recorded · Dev server: web :3000' })
			.waitFor({ timeout: 5000 });
		expect(await page.locator('.chat strong', { hasText: 'REDIS_URL' }).count()).toBe(1);
		// Docked at the card's foot, right above the composer; nothing to say aloud.
		const dock = page.locator('.ss-foot > section.dock.question');
		await dock.waitFor({ timeout: 5000 });
		expect(
			await page
				.locator('.ss-foot > *')
				.evaluateAll((nodes) => nodes.map((node) => node.className)),
		).toEqual(['dock question', 'reply']);
		expect(await dock.innerText()).not.toContain('Say');

		await dock.getByRole('button', { name: /Skip the worker/ }).click();
		await waitUntil(() => server.store.state.asks.every((ask) => ask.id !== 'setup-q1'));
		expect(answerOf('setup-q1')).toMatchObject({
			action: { type: 'answer_question', answers: { [REDIS]: 'Skip the worker' } },
		});
		await dock.waitFor({ state: 'detached', timeout: 5000 });

		// Your own words, from the dock's own field.
		openQuestion('setup-q2');
		await dock.getByLabel('Your own answer…').fill('use the one in docker compose');
		await dock.getByRole('button', { name: 'Send' }).click();
		await waitUntil(() => server.store.state.asks.every((ask) => ask.id !== 'setup-q2'));
		expect(answerOf('setup-q2')).toMatchObject({
			action: { answers: { [REDIS]: 'use the one in docker compose' } },
		});
		await context.close();
	}, 20_000);

	it('✕ declines the question', async () => {
		openQuestion('setup-q3');
		const { context, page } = await open('/setup/chat');
		await page.getByRole('button', { name: 'Decline the question' }).click();
		await waitUntil(() => server.store.state.asks.every((ask) => ask.id !== 'setup-q3'));
		expect(answerOf('setup-q3')).toMatchObject({ action: { type: 'decline_question' } });
		await page.locator('.ss-foot .dock').waitFor({ state: 'detached', timeout: 5000 });
		await context.close();
	}, 20_000);

	it('busy: the reply arriving with its caret, your words queued below it, sent when the turn ends', async () => {
		server.store.dispatch({ type: 'send', ref: 'setup', text: 'check this machine' });
		server.store.dispatch({ type: 'text_delta', ref: 'setup', text: 'Reading the compose file' });
		const { context, page } = await open('/setup/chat');
		await page
			.locator('.chat .line.text', { hasText: 'Reading the compose file' })
			.locator('.caret')
			.waitFor({ timeout: 5000 });

		await page.getByLabel('Reply to setup').fill('then add signals');
		await page.getByRole('button', { name: 'Queue', exact: true }).click();
		const queued = page.locator('.ss-foot .queue .qitem', { hasText: 'then add signals' });
		await queued.waitFor({ timeout: 5000 });
		expect(await queued.locator('.qtag').textContent()).toBe('queued 1');
		expect(server.store.state.sessions.setup?.queue.map((item) => item.text)).toEqual([
			'then add signals',
		]);

		server.store.dispatch({ type: 'turn_ended', ref: 'setup', costUsd: 0, text: '' });
		await queued.waitFor({ state: 'detached', timeout: 5000 });
		await page
			.locator('.chat .line.user', { hasText: 'then add signals' })
			.waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('"Fix with Claude" while setup is idle → the chat, the prompt in its composer and focused, once', async () => {
		await waitUntil(() => server.store.state.sessions.setup?.status === 'idle');
		const { context, page } = await open('/setup');
		await page
			.locator('.problem', { hasText: 'store-front/wrk1' })
			.getByRole('button', { name: 'Fix with Claude' })
			.click();
		await page.waitForURL('**/setup/chat');
		const composer = page.getByLabel('Reply to setup');
		expect(await composer.inputValue()).toContain('store-front/wrk1');
		expect(await composer.evaluate((node) => node === document.activeElement)).toBe(true);

		// Handed over once: away and back, the composer is empty.
		await page.goBack();
		await page.waitForURL(/\/setup$/);
		await page.locator('.claude-card').getByRole('button', { name: 'Open' }).click();
		await page.waitForURL('**/setup/chat');
		expect(await page.getByLabel('Reply to setup').inputValue()).toBe('');
		await context.close();
	}, 20_000);

	describe("a remote machine's chat", () => {
		const VM1 = { id: 'vm1', host: 'dev@vm1', name: 'Build box' };
		const LOCAL_WORKTREES = [createWorktree('setup', true), createWorktree('store-front/main')];

		beforeEach(() => {
			server.store.dispatch({ type: 'machines', machines: [VM1] });
			server.store.dispatch({
				type: 'worktrees',
				worktrees: [...LOCAL_WORKTREES, { ...createWorktree('vm1:setup', true), label: 'setup' }],
			});
			server.store.dispatch({
				type: 'machine_resynced',
				id: 'vm1',
				inputs: [{ type: 'session_started', ref: 'vm1:setup' }],
			});
		});

		afterEach(() => {
			for (const ask of server.store.state.asks) {
				server.store.dispatch({ type: 'decline_question', askId: ask.id });
			}

			server.store.dispatch({ type: 'machines', machines: [] });
			server.store.dispatch({ type: 'worktrees', worktrees: LOCAL_WORKTREES });
		});

		it("Send from the idle composer goes to that machine's setup session", async () => {
			await waitUntil(() => server.store.state.sessions['vm1:setup']?.status === 'idle');
			const { context, page } = await open('/setup/chat?on=vm1');
			await page.getByLabel('Reply to setup').fill('check this machine');
			await page.getByRole('button', { name: 'Send', exact: true }).click();
			const findSent = () =>
				server.received.find(
					(entry) =>
						entry.message.type === 'action' &&
						entry.message.action.type === 'send' &&
						entry.message.action.text === 'check this machine',
				);
			await waitUntil(() => findSent() !== undefined);
			expect(findSent()?.message).toMatchObject({ action: { type: 'send', ref: 'vm1:setup' } });
			await context.close();
		}, 20_000);

		it("its own question docked, never this Mac's; answering it leaves this Mac's open", async () => {
			openQuestion('setup-local');
			server.store.dispatch({
				type: 'ask_opened',
				ask: {
					id: 'setup-vm1',
					ref: 'vm1:setup',
					at: 2,
					kind: 'question',
					input: {},
					questions: [
						{
							question: 'Which Postgres on the build box?',
							header: 'Database',
							multiSelect: false,
							options: [{ label: 'The local one' }, { label: 'Skip it' }],
						},
					],
				},
			});
			const { context, page } = await open('/setup/chat?on=vm1');
			const dock = page.locator('.ss-foot > section.dock.question');
			await dock.waitFor({ timeout: 5000 });
			expect(await page.locator('.ss-foot section.dock').count()).toBe(1);
			expect(await dock.innerText()).toContain('Which Postgres on the build box?');
			expect(await dock.innerText()).not.toContain(REDIS);

			await dock.getByRole('button', { name: /The local one/ }).click();
			await waitUntil(() => server.store.state.asks.every((ask) => ask.id !== 'setup-vm1'));
			expect(answerOf('setup-vm1')).toMatchObject({
				action: {
					type: 'answer_question',
					answers: { 'Which Postgres on the build box?': 'The local one' },
				},
			});
			expect(server.store.state.asks.map((ask) => ask.id)).toEqual(['setup-local']);
			await context.close();
		}, 20_000);
	});
});

describe('moving to another machine', () => {
	const writeBundle = (bundle: unknown): string => {
		const file = join(mkdtempSync(join(tmpdir(), 'crew-import-')), 'crew-export.json');
		writeFileSync(file, JSON.stringify(bundle));

		return file;
	};

	// This machine's export, kept past its browser context (a download goes with the context).
	const exportEverything = async (): Promise<string> => {
		const { context, page } = await open('/setup/export');
		await page.locator('[data-row="admin"]').waitFor({ timeout: 5000 });
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.getByRole('button', { name: 'Save crew-export.json' }).click(),
		]);
		const text = await Bun.file(await download.path()).text();
		await context.close();

		return writeBundle(JSON.parse(text));
	};

	it('Export: workspaces bring their projects; the command follows the picks; the file is saved', async () => {
		const { context, page } = await open('/setup/settings');
		await page.getByRole('button', { name: 'Export…' }).click();
		await page.waitForURL('**/setup/export');
		const exportPage = page.locator('section[aria-label="Export"]');
		await exportPage.locator('[data-row="admin"]').waitFor({ timeout: 5000 });
		expect(await exportPage.locator('[data-member="signals"]').innerText()).toContain('setup only');
		expect(await exportPage.locator('.runs pre').innerText()).toContain('crew export --all');

		await exportPage.locator('[data-row="admin"]').click();
		expect(await exportPage.locator('.runs pre').innerText()).toMatch(
			/^crew export .*--projects=store-front,store-api,signals --workspaces=store-front/,
		);
		await exportPage.locator('[data-row="store-front"]').click();
		expect(
			await exportPage.getByRole('button', { name: 'Save crew-export.json' }).isDisabled(),
		).toBe(true);
		await exportPage.locator('[data-row="store-front"]').click();
		await exportPage.locator('[data-row="admin"]').click();

		const [download] = await Promise.all([
			page.waitForEvent('download'),
			exportPage.getByRole('button', { name: 'Save crew-export.json' }).click(),
		]);
		expect(download.suggestedFilename()).toBe('crew-export.json');
		expect(commandsOf('export')).toEqual([{ type: 'export', all: true }]);
		const bundle = JSON.parse(await Bun.file(await download.path()).text()) as {
			version: number;
			projects: { name: string; path?: string }[];
		};
		expect(bundle.version).toBe(2);
		expect(bundle.projects.every((project) => project.path === undefined)).toBe(true);
		await exportPage.getByText(/Saved crew-export.json/).waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('Import: every choice first, one Import, progress, then Voice OS on the new session', async () => {
		const file = await exportEverything();

		// The other machine: nothing recorded, but store-front is already checked out there.
		server.crew.reset('empty');
		const { context, page } = await open('/setup/import');
		const importPage = page.locator('section[aria-label="Import"]');
		await importPage.getByLabel('Export file').setInputFiles(file);
		const storeFront = importPage.locator('[data-project="store-front"]');
		await storeFront.getByText('already checked out at /Users/dev/code/store-front').waitFor({
			timeout: 5000,
		});
		expect(
			await storeFront.getByRole('button', { name: 'Use mine' }).getAttribute('aria-pressed'),
		).toBe('true');
		expect(await importPage.locator('[aria-current="step"]').innerText()).toBe('Choose');
		const go = importPage.getByRole('button', { name: /choice left|Import \d/ });
		expect(await go.innerText()).toBe('1 choice left');
		expect(await go.isDisabled()).toBe(true);
		expect(await importPage.locator('[data-row="store-front"]').innerText()).toContain(
			'waits on signals',
		);

		const signals = importPage.locator('[data-project="signals"]');
		await signals.getByRole('button', { name: 'Skip' }).click();
		expect(await importPage.locator('[data-row="store-front"]').isDisabled()).toBe(true);
		expect(await importPage.locator('[data-row="store-front"]').innerText()).toContain(
			'needs signals',
		);

		await signals.getByRole('button', { name: 'Point at a folder' }).click();
		await signals.getByLabel('Folder for signals').fill('/Users/dev/code/signals');
		expect(await importPage.locator('.runs pre').innerText()).toContain(
			'crew import - project store-front --path=/Users/dev/code/store-front',
		);
		await importPage.getByRole('button', { name: 'Import 5 items' }).click();

		await importPage.getByRole('heading', { name: 'Imported' }).waitFor({ timeout: 15_000 });
		expect(await importPage.getByText('3 projects and 2 workspaces came in.').count()).toBe(1);
		expect(
			commandsOf('import_project').map((command) => ('path' in command ? command.path : 'clone')),
		).toEqual(['/Users/dev/code/store-front', 'clone', '/Users/dev/code/signals']);
		expect(
			commandsOf('import_workspace').map((command) => 'name' in command && command.name),
		).toEqual(['store-front', 'admin']);

		await importPage.getByRole('button', { name: /Open Voice OS/ }).click();
		await page.waitForURL('**/voice/session/store-front/main');
		await waitUntil(() => server.store.state.active.includes('store-front/main'));
		server.store.dispatch({ type: 'deactivate', ref: 'store-front/main' });
		server.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		await context.close();
	}, 40_000);

	it('a different repo here under that name: Replace mine is refused while a workspace uses it; Import as -2 works', async () => {
		const file = writeBundle({
			version: 2,
			projects: [{ name: 'store-api', remote: 'git@github.com:other/store-api.git' }],
			workspaces: [],
		});
		const { context, page } = await open('/setup/import');
		const importPage = page.locator('section[aria-label="Import"]');
		await importPage.getByLabel('Export file').setInputFiles(file);
		const row = importPage.locator('[data-project="store-api"]');
		await row.getByText(/a different repo here has that name/).waitFor({ timeout: 5000 });
		await row.locator('button[disabled]', { hasText: 'Replace mine' }).waitFor({ timeout: 5000 });
		expect(await row.getByRole('button', { name: 'Replace mine' }).getAttribute('title')).toContain(
			'store-api is in store-front here',
		);

		await row.getByRole('button', { name: 'Import as store-api-2' }).click();
		await importPage.getByRole('button', { name: 'Import 1 item' }).click();
		await importPage.getByRole('heading', { name: 'Imported' }).waitFor({ timeout: 10_000 });
		expect(commandsOf('import_project')).toEqual([
			{
				type: 'import_project',
				bundle: expect.any(String),
				name: 'store-api',
				rename: 'store-api-2',
			},
		]);
		await importPage.getByRole('button', { name: /Go to the board/ }).waitFor();
		expect(await importPage.getByRole('button', { name: /Open Voice OS/ }).isDisabled()).toBe(true);
		await context.close();
	}, 30_000);

	it("a file that isn't an export → crew's refusal, still on the file step", async () => {
		const file = writeBundle({ hello: 'world' });
		const { context, page } = await open('/setup/import');
		const importPage = page.locator('section[aria-label="Import"]');
		await importPage.getByLabel('Export file').setInputFiles(file);
		await importPage.locator('.result-line.bad').waitFor({ timeout: 5000 });
		expect(await importPage.locator('.result-line.bad').innerText()).toContain('not a crew export');
		expect(await importPage.locator('[aria-current="step"]').innerText()).toBe('File');
		await context.close();
	}, 20_000);

	it('at phone width the choices fit: nothing scrolls sideways', async () => {
		const file = await exportEverything();
		server.crew.reset('empty');

		const { context, page } = await open('/setup/import', { width: 390, height: 844 });
		await page.getByLabel('Export file').setInputFiles(file);
		await page.locator('[data-project="signals"]').waitFor({ timeout: 5000 });
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
		await context.close();
	}, 20_000);
});

describe('first run', () => {
	// The first run is Home on a Mac with no worktree yet: the opening, then its steps under the
	// wordmark.
	const startFirstRun = async (path = '/', viewport?: { width: number; height: number }) => {
		const opened = await open(path, viewport);
		const flow = opened.page.locator('main[aria-label="First run"]');
		await flow.getByRole('button', { name: 'Get started' }).click({ timeout: 5000 });

		return { ...opened, flow };
	};

	const currentStep = (flow: Locator) => flow.locator('.fr-progress [aria-current="step"]');

	// Past the projects step with every found checkout added, the workspace named.
	const makeWorkspace = async (flow: Locator, name?: string) => {
		await flow.locator('[data-row="checkout-api"]').waitFor({ timeout: 5000 });
		await flow.getByRole('button', { name: 'Add 3 projects' }).click();
		await flow.getByRole('heading', { name: 'Make a workspace' }).waitFor({ timeout: 5000 });

		if (name) {
			await flow.getByRole('textbox', { name: 'Name' }).fill(name);
		}
	};

	const leaveSession = (ref: string) => {
		server.latency.worktreesMs = 0;
		server.store.dispatch({ type: 'deactivate', ref });
		server.store.dispatch({
			type: 'worktrees',
			worktrees: [createWorktree('setup', true), createWorktree('store-front/main')],
		});
		server.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
	};

	it('opening → pick checkouts → a workspace → an install fails → Retry → ready → Open Voice OS on its session', async () => {
		server.crew.reset('empty');
		server.crew.failInstall('infra-ops');
		const { context, page, flow } = await startFirstRun();
		expect(await currentStep(flow).innerText()).toBe('Projects');
		expect(await flow.getByText('Import from another machine').count()).toBe(0);

		await makeWorkspace(flow);
		expect(commandsOf('add_project').map((command) => 'name' in command && command.name)).toEqual([
			'store-front',
			'checkout-api',
			'infra-ops',
		]);
		expect(await currentStep(flow).innerText()).toBe('Workspace');
		expect(await flow.getByText('your session: store-front/main').count()).toBe(1);
		expect(await flow.locator('.runs pre').innerText()).toContain(
			'crew add workspace store-front store-front checkout-api infra-ops',
		);

		await flow.getByRole('button', { name: 'Create store-front' }).click();
		await flow
			.getByRole('heading', { name: 'Getting store-front/main ready' })
			.waitFor({ timeout: 5000 });
		expect(await currentStep(flow).innerText()).toBe('Getting it ready');
		const fail = flow.locator('.fail');
		await fail.getByText(/infra-ops: install failed/).waitFor({ timeout: 10_000 });
		await fail.getByRole('button', { name: 'Retry' }).click();
		await fail.waitFor({ state: 'detached', timeout: 10_000 });

		await flow
			.getByRole('heading', { name: 'store-front/main is ready' })
			.waitFor({ timeout: 10_000 });
		expect(await flow.getByText('3 projects checked out and installed.').count()).toBe(1);
		expect(commandsOf('setup_rerun')).toEqual([
			{ type: 'setup_rerun', ref: 'store-front/main', projects: ['infra-ops'] },
		]);
		const voice = flow.getByRole('button', { name: /Open Voice OS/ });
		expect(await voice.evaluate((node) => node === document.activeElement)).toBe(true);

		await page.keyboard.press('Enter');
		await page.waitForURL('**/voice/session/store-front/main');
		await waitUntil(() => server.store.state.active.includes('store-front/main'));
		server.store.dispatch({ type: 'deactivate', ref: 'store-front/main' });
		await context.close();
	}, 40_000);

	it('Open Voice OS on a worktree Voice OS has not listed yet → it is read at once, activated and shown', async () => {
		server.crew.reset('empty');
		const { context, page, flow } = await startFirstRun();
		await makeWorkspace(flow, 'checkout-api');
		await flow.getByRole('button', { name: 'Create checkout-api' }).click();
		await flow
			.getByRole('heading', { name: 'checkout-api/main is ready' })
			.waitFor({ timeout: 10_000 });
		expect(server.store.state.sessions['checkout-api/main']).toBeUndefined();
		// As live: the page's switch to the session lands before crew's list has it, so only the
		// held activation's open can show it.
		server.latency.worktreesMs = 400;

		await flow.getByRole('button', { name: /Open Voice OS/ }).click();
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

		leaveSession('checkout-api/main');
		await context.close();
	}, 40_000);

	it('a failure carried on → the last step says what failed; Fix with Claude → the chat with the prompt', async () => {
		server.crew.reset('empty');
		server.crew.failInstall('infra-ops');
		await waitUntil(() => server.store.state.sessions.setup?.status === 'idle');
		const { context, page, flow } = await startFirstRun();
		await makeWorkspace(flow);
		await flow.getByRole('button', { name: 'Create store-front' }).click();
		await flow
			.locator('.fail')
			.getByText(/infra-ops: install failed/)
			.waitFor({ timeout: 10_000 });

		await flow.getByRole('button', { name: 'Continue' }).click();
		await flow
			.getByText('2 of 3 projects installed; infra-ops failed: Set up shows it.')
			.waitFor({ timeout: 5000 });
		await flow.getByRole('button', { name: /Go to Set up/ }).click();
		await page.waitForURL((url) => url.pathname === '/setup');
		// The worktree exists now: the board stays, it never sends the developer back.
		await page.locator('.matrix').waitFor({ timeout: 5000 });
		await Bun.sleep(300);
		expect(new URL(page.url()).pathname).toBe('/setup');
		await context.close();

		// Reopened while it is still failed: the launcher, no first run.
		const again = await open('/');
		await again.page.locator('main[aria-label="Home"] .launch-choices').waitFor({ timeout: 5000 });
		expect(await again.page.locator('main[aria-label="First run"]').count()).toBe(0);
		await again.context.close();
	}, 40_000);

	it('Fix with Claude from the first run → Set up with Claude, the prompt in its composer', async () => {
		server.crew.reset('empty');
		server.crew.failInstall('infra-ops');
		await waitUntil(() => server.store.state.sessions.setup?.status === 'idle');
		const { context, page, flow } = await startFirstRun();
		await makeWorkspace(flow);
		await flow.getByRole('button', { name: 'Create store-front' }).click();
		const fail = flow.locator('.fail');
		await fail.getByText(/infra-ops: install failed/).waitFor({ timeout: 10_000 });

		await fail.getByRole('button', { name: 'Fix with Claude' }).click();
		await page.waitForURL('**/setup/chat');
		// Set up asks it once it is up, through its own busy check: the composer fills a beat later.
		await page.waitForFunction(
			() =>
				(
					document.querySelector('[aria-label="Reply to setup"]') as HTMLInputElement | null
				)?.value.startsWith('Fix infra-ops in store-front/main: '),
			undefined,
			{ timeout: 5000 },
		);
		await context.close();
	}, 40_000);

	it('Add by URL → crew add project with the URL, the project added in place', async () => {
		server.crew.reset('empty');
		const { context, flow } = await startFirstRun();
		await flow.getByRole('button', { name: 'Add by URL' }).click();
		await flow
			.getByRole('textbox', { name: 'Git URL' })
			.fill('https://github.com/acme/payments.git');
		expect(await flow.locator('.fr-adder .runs pre').innerText()).toContain(
			'crew add project payments https://github.com/acme/payments.git',
		);
		await flow.getByRole('button', { name: 'Add payments' }).click();
		await flow.locator('[data-row="payments"]').waitFor({ timeout: 5000 });

		expect(commandsOf('add_project')).toEqual([
			{ type: 'add_project', name: 'payments', url: 'https://github.com/acme/payments.git' },
		]);
		expect(await flow.locator('[data-row="payments"]').innerText()).toContain('added');
		await context.close();
	}, 20_000);

	it('projects already added → the opening goes to the workspace; Back, nothing new ticked → Continue', async () => {
		server.crew.reset('empty');
		const first = await startFirstRun();
		await makeWorkspace(first.flow);
		await first.context.close();

		const { context, flow } = await startFirstRun();
		await flow.getByRole('heading', { name: 'Make a workspace' }).waitFor({ timeout: 5000 });
		await flow.getByRole('button', { name: 'Back' }).click();
		await flow.locator('[data-row="infra-ops"]').waitFor({ timeout: 5000 });
		await flow.getByRole('button', { name: 'Continue' }).click();
		await flow.getByRole('heading', { name: 'Make a workspace' }).waitFor({ timeout: 5000 });
		expect(commandsOf('add_project')).toHaveLength(3);
		await context.close();
	}, 30_000);

	it('a workspace made earlier with no worktree → Create joins it and makes its main', async () => {
		server.crew.reset('empty');
		const { context, flow } = await startFirstRun();
		await makeWorkspace(flow);
		// As `crew add workspace store-front` from a terminal with no members would leave it.
		server.crew.machines.local?.workspaces.push({
			name: 'store-front',
			projects: [{ name: 'store-front', mode: 'worktree' }],
			worktrees: [],
		});
		// The step reads crew's workspaces as it opens: back and forward again reads them.
		await flow.getByRole('button', { name: 'Back' }).click();
		await flow.getByRole('button', { name: 'Continue' }).click();
		await flow
			.locator('.runs pre', { hasText: 'crew add worktree store-front/main' })
			.waitFor({ timeout: 5000 });
		expect(await flow.locator('.runs pre').innerText()).toContain(
			'crew add workspace store-front checkout-api infra-ops',
		);

		await flow.getByRole('button', { name: 'Create store-front' }).click();
		await flow
			.getByRole('heading', { name: 'Getting store-front/main ready' })
			.waitFor({ timeout: 5000 });
		expect(commandsOf('add_workspace')).toEqual([
			{ type: 'add_workspace', name: 'store-front', projects: ['checkout-api', 'infra-ops'] },
		]);
		expect(commandsOf('add_worktree')).toEqual([{ type: 'add_worktree', ref: 'store-front/main' }]);
		await context.close();
	}, 30_000);

	it('reopened while its worktree installs → straight back to its progress, then ready', async () => {
		server.crew.reset('empty');
		const first = await startFirstRun();
		await makeWorkspace(first.flow);
		await first.flow.getByRole('button', { name: 'Create store-front' }).click();
		await first.flow
			.getByRole('heading', { name: 'Getting store-front/main ready' })
			.waitFor({ timeout: 5000 });
		await first.context.close();
		// Held mid-install: its runners started in the future never finish until let go.
		const run = server.crew.machines.local?.worktrees.find(
			(worktree) => worktree.ref === 'store-front/main',
		)?.run;
		expect(run).toBeTruthy();

		if (run) {
			run.startedAt = Date.now() + 60_000;
		}

		const { context, page } = await open('/');
		const flow = page.locator('main[aria-label="First run"]');
		await flow
			.getByRole('heading', { name: 'Getting store-front/main ready' })
			.waitFor({ timeout: 5000 });
		expect(await flow.getByRole('button', { name: 'Get started' }).count()).toBe(0);

		if (run) {
			run.startedAt = 0;
		}

		await flow
			.getByRole('heading', { name: 'store-front/main is ready' })
			.waitFor({ timeout: 10_000 });
		await context.close();
	}, 40_000);

	it("Set up's board on a first run → the first run, at /", async () => {
		server.crew.reset('empty');
		const { context, page } = await open('/setup');
		await page.waitForURL((url) => url.pathname === '/', { timeout: 5000 });
		await page.getByRole('button', { name: 'Get started' }).waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('a reload of / → the title from the first frame, never a "Connecting…" card before it', async () => {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		// Watches every frame of the page for the card, from before the app's first render.
		await context.addInitScript(() => {
			const seen = { connecting: false };
			Object.assign(window, { seen });
			new MutationObserver(() => {
				if (document.body?.innerText.includes('Connecting')) {
					seen.connecting = true;
				}
			}).observe(document, { childList: true, subtree: true, characterData: true });
		});
		const page = await context.newPage();
		page.on('pageerror', (error) => pageErrors.push(error.message));
		await page.goto(server.loginUrl());
		await page.goto(server.url('/'));
		await page.locator('.intro').waitFor({ timeout: 5000 });
		await page.locator('.intro').waitFor({ state: 'detached', timeout: 8000 });
		await page.locator('main[aria-label="Home"]').waitFor({ timeout: 5000 });

		expect(
			await page.evaluate(
				() => (window as unknown as { seen: { connecting: boolean } }).seen.connecting,
			),
		).toBe(false);
		await context.close();
	}, 20_000);

	it('with motion: the title and the Voice OS moment play once per load, never again on the crew mark or the card', async () => {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await context.newPage();
		page.on('pageerror', (error) => pageErrors.push(error.message));
		await page.goto(server.loginUrl());
		await page.goto(server.url('/'));
		await page.locator('.intro').first().waitFor({ timeout: 5000 });
		await page.locator('.intro').waitFor({ state: 'detached', timeout: 8000 });

		const voiceCard = page.locator('.launch-choice', { hasText: 'Voice OS' });
		await voiceCard.click();
		await page.locator('.vo-moment').waitFor({ timeout: 3000 });
		await page.locator('.vo-moment').waitFor({ state: 'detached', timeout: 6000 });

		await page.getByRole('button', { name: 'crew voice os' }).click();
		await page.locator('main[aria-label="Home"] .launch-choices').waitFor({ timeout: 5000 });
		await Bun.sleep(400);
		expect(await page.locator('.intro').count()).toBe(0);

		await voiceCard.click();
		await page.waitForURL((url) => url.pathname.startsWith('/voice'));
		await Bun.sleep(400);
		expect(await page.locator('.vo-moment').count()).toBe(0);
		server.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		await context.close();
	}, 30_000);

	it('with motion: the opening dissolves onto the first run, Get started takes it on', async () => {
		server.crew.reset('empty');
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await context.newPage();
		page.on('pageerror', (error) => pageErrors.push(error.message));
		await page.goto(server.loginUrl());
		await page.goto(server.url('/'));
		await page.locator('.intro').waitFor({ state: 'detached', timeout: 6000 });
		await page.getByRole('button', { name: 'Get started' }).click();
		await page.getByRole('heading', { name: 'Pick your projects' }).waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('at phone width every step fits: nothing scrolls sideways', async () => {
		server.crew.reset('empty');
		const { context, page, flow } = await startFirstRun('/', { width: 390, height: 844 });
		const width = () => page.evaluate(() => document.querySelector('.first-run')?.scrollWidth ?? 0);
		await flow.locator('[data-row="checkout-api"]').waitFor({ timeout: 5000 });
		expect(await width()).toBe(390);

		await makeWorkspace(flow);
		expect(await width()).toBe(390);
		await flow.getByRole('button', { name: 'Create store-front' }).click();
		await flow
			.getByRole('heading', { name: 'store-front/main is ready' })
			.waitFor({ timeout: 10_000 });
		expect(await width()).toBe(390);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
		await context.close();
	}, 40_000);
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
			await page.getByText(/^Already here · /).click();
			await page
				.locator('[data-project="store-front"]')
				.getByRole('button', { name: 'Replace mine' })
				.click();
			await page.getByRole('button', { name: 'Import 1 item' }).click();
		},
		dialog: 'Replace store-front?',
		cost: 'its checkout and worktrees stay',
		type: 'import_project',
		command: {
			type: 'import_project',
			bundle: '',
			name: 'store-front',
			replace: true,
			confirm: true,
		},
		action: 'Replace and import',
		after: (page) => page.getByRole('heading', { name: 'Imported' }).waitFor(),
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

	it('a first run → Home stays, and Home is the first run', async () => {
		server.crew.reset('empty');
		const { context, page } = await open('/', undefined, ALWAYS);
		await page.getByRole('button', { name: 'Get started' }).waitFor({ timeout: 5000 });
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
