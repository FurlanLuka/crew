// The real UI bundle and gateway, with a store the test drives instead of Claude workers.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import index from '../../src/web/index.html';
import { listAllowedOrigins } from '../../src/gateway/auth.js';
import { startGateway, type Gateway } from '../../src/gateway/server.js';
import { configureLog } from '../../src/log.js';
import type { Action, ClientMessage, WorktreeInfo } from '../../src/shared/protocol.js';
import { Store } from '../../src/state/store.js';

const TOKEN = 'b'.repeat(64);
const createWorktree = (ref: string, isPinned = false): WorktreeInfo => ({
	ref,
	label: ref,
	branch: `crew/${ref}`,
	cwd: `/w/${ref}`,
	dirs: [],
	isPinned,
});

interface ReceivedMessage {
	message: ClientMessage;
	client: string;
}

interface SignedInTab {
	context: BrowserContext;
	page: Page;
}

interface MicTab extends SignedInTab {
	client: string;
}

interface SpeakerTab {
	page: Page;
	client: string;
	done: () => string[];
}

let browser: Browser;
let gateway: Gateway;
let store: Store;
const received: ReceivedMessage[] = [];
const audioChunks: number[] = [];
const effects: string[] = [];

const waitUntil = async (check: () => boolean, timeoutMs = 5000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;

	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error('condition not met in time');
		}

		await Bun.sleep(20);
	}
};

const ensureIdle = async (ref: string): Promise<void> => {
	// Earlier tests leave sessions in any state: bring this one to a quiet idle.
	const status = store.state.sessions[ref]?.status;

	if (status === 'stopped') {
		store.dispatch({ type: 'start_session', ref });
	} else if (status === 'running' || status === 'blocked') {
		store.dispatch({ type: 'interrupt', ref });
		store.dispatch({ type: 'turn_ended', ref, costUsd: 0, text: '' });
	}

	await waitUntil(() => store.state.sessions[ref]?.status === 'idle');
};

const startServer = (port = 0): Gateway => {
	return startGateway({
		store,
		token: TOKEN,
		port,
		index,
		listAllowedOrigins: (serverPort) =>
			listAllowedOrigins({ port: serverPort, proxyHost: null, proxyPort: null }),
		onMessage: (message, client) => {
			received.push({ message, client });

			if (message.type === 'action') {
				store.dispatch(message.action);
			}
		},
		onAudio: (chunk) => audioChunks.push(chunk.byteLength),
		readHealth: () => ({}),
		development: true,
	});
};

// An uncaught error in the page (a component that throws while rendering) fails the test it happened in.
const pageErrors: string[] = [];

const watchErrors = (page: Page): void => {
	page.on('pageerror', (error) =>
		pageErrors.push(`${error.message}\n${(error.stack ?? '').slice(0, 900)}`),
	);
};

const chooseMode = async (page: Page, name: string): Promise<void> => {
	await page.getByRole('button', { name: 'Listening mode' }).click();
	await page.getByRole('menuitemradio', { name }).click();
};

const readMode = (page: Page): Promise<string | null> =>
	page.locator('.mode-button').getAttribute('data-mode');

const signIn = async (beforeLoad?: () => void): Promise<SignedInTab> => {
	const context = await browser.newContext({ permissions: ['microphone'] });

	if (beforeLoad) {
		await context.addInitScript(beforeLoad);
	}

	const page = await context.newPage();
	watchErrors(page);
	await page.goto(`http://localhost:${gateway.port}/login?token=${TOKEN}`);
	await page.waitForSelector('.topbar');

	return { context, page };
};

beforeAll(async () => {
	configureLog({ quiet: true });
	store = new Store();
	store.onEffect((effect) => {
		effects.push(effect.type);

		// Stand in for a worker so start_session reaches idle.
		if (effect.type === 'worker_start') {
			queueMicrotask(() => store.dispatch({ type: 'session_started', ref: effect.ref }));
		}
	});
	store.dispatch({
		type: 'worktrees',
		worktrees: [
			createWorktree('setup', true),
			createWorktree('store-front/main'),
			createWorktree('checkout-api/main'),
		],
	});
	gateway = startServer();
	browser = await chromium.launch({
		args: [
			'--use-fake-ui-for-media-stream',
			'--use-fake-device-for-media-stream',
			'--autoplay-policy=no-user-gesture-required',
		],
	});
});

afterEach(() => {
	const errors = pageErrors.splice(0);
	expect(errors).toEqual([]);
});

afterAll(async () => {
	await browser?.close();
	gateway?.stop();
});

describe('voice os ui', () => {
	it('without signing in → the "open it from crew" card, no state', async () => {
		const context = await browser.newContext();
		const page = await context.newPage();
		watchErrors(page);
		await page.goto(`http://localhost:${gateway.port}/`);

		await expect(
			page.getByText('Open Voice OS from crew').waitFor({ timeout: 10_000 }),
		).resolves.toBeUndefined();
		await context.close();
	}, 20_000);

	it('home → the machine cards; This Mac opens its grid: every worktree, the setup session first', async () => {
		const { context, page } = await signIn();

		// Home is the machine cards: this Mac's opens its grid.
		await page.locator('section.machine[aria-label="This Mac"] .machine-name').click();
		await page.locator('.tile').first().waitFor({ timeout: 5000 });

		const refs = await page
			.locator('.tile')
			.evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-ref')));

		expect(refs).toEqual(['setup', 'checkout-api/main', 'store-front/main']);
		await context.close();
	}, 20_000);

	it('click a tile in one tab → both tabs open that session (server-driven view)', async () => {
		const firstTab = await signIn();
		const secondTab = await signIn();
		await firstTab.page.locator('.tile[data-ref="store-front/main"]').click();

		await secondTab.page.getByRole('navigation').waitFor({ timeout: 5000 });
		expect(await secondTab.page.locator('.tab.on').innerText()).toContain('store-front/main');
		expect(store.state.view).toEqual({ kind: 'session', ref: 'store-front/main' });
		await firstTab.context.close();
		await secondTab.context.close();
	}, 20_000);

	it('permission → clicking Yes resolves the ask with allow', async () => {
		const { context, page } = await signIn();
		store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'ui-p1',
				ref: 'store-front/main',
				at: 1,
				kind: 'permission',
				toolName: 'Bash',
				summary: 'run git push',
				input: { command: 'git push' },
				suggestions: [],
			},
		});
		await page.getByText('store-front/main wants to run git push.').waitFor({ timeout: 5000 });
		await page.getByRole('button', { name: /Yes/ }).click();

		await waitUntil(() => store.state.asks.length === 0);
		const answer = received
			.map((entry) => entry.message)
			.find(
				(message) => message.type === 'action' && message.action.type === 'answer_permission',
			) as { type: 'action'; action: Extract<Action, { type: 'answer_permission' }> } | undefined;
		expect(answer?.action).toEqual({
			type: 'answer_permission',
			askId: 'ui-p1',
			decision: 'allow',
		});
		expect(store.state.asks).toEqual([]);
		await context.close();
	}, 20_000);

	it('question → clicking an option answers with its label', async () => {
		const { context, page } = await signIn();
		// Another session's question docks only on its own screen.
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'ui-q1',
				ref: 'checkout-api/main',
				at: 2,
				kind: 'question',
				input: {},
				questions: [
					{
						question: 'Where should events go?',
						multiSelect: false,
						options: [
							{ label: 'New table' },
							{ label: 'Reuse orders', description: 'No migration.' },
						],
					},
				],
			},
		});
		await page.getByRole('button', { name: /Reuse orders/ }).waitFor({ timeout: 5000 });
		await page.getByRole('button', { name: /Reuse orders/ }).click();

		await waitUntil(() =>
			received.some(
				(entry) =>
					entry.message.type === 'action' && entry.message.action.type === 'answer_question',
			),
		);
		expect(
			received.some(
				(entry) =>
					entry.message.type === 'action' &&
					entry.message.action.type === 'answer_question' &&
					entry.message.action.answers['Where should events go?'] === 'Reuse orders',
			),
		).toBe(true);
		await context.close();
	}, 20_000);

	it('typed command → sent as an utterance; the chip shows this session for plain text, Voice OS when addressed to another', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		const input = page.getByLabel('Say or type a command');
		await input.fill('run the tests');
		expect(await page.locator('.route').innerText()).toBe('→ store-front/main');
		// Addressed to another session: not this Claude's input, Voice OS routes it.
		await input.fill('checkout-api/main, run the tests');
		expect(await page.locator('.route').innerText()).toBe('→ Voice OS');
		await input.press('Enter');

		await waitUntil(() => received.some((entry) => entry.message.type === 'utterance'));
		expect(
			received.some(
				(entry) =>
					entry.message.type === 'utterance' &&
					entry.message.text === 'checkout-api/main, run the tests',
			),
		).toBe(true);
		await context.close();
	}, 20_000);

	const listFromClient = (client: string, type: string) =>
		received.filter((entry) => entry.client === client && entry.message.type === type);

	const openMicTab = async (): Promise<MicTab> => {
		const context = await browser.newContext({ permissions: ['microphone'] });
		await context.addInitScript(() => {
			const probe = window as unknown as { __gum: number; __echo: unknown[] };
			probe.__gum = 0;
			probe.__echo = [];
			const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

			navigator.mediaDevices.getUserMedia = (constraints) => {
				probe.__gum++;
				probe.__echo.push(
					typeof constraints?.audio === 'object' ? constraints.audio.echoCancellation : null,
				);

				return getUserMedia(constraints);
			};
		});
		const page = await context.newPage();
		watchErrors(page);
		await page.goto(`http://localhost:${gateway.port}/login?token=${TOKEN}`);
		await page.waitForSelector('.topbar');
		const before = received.length;
		await page.locator('body').click();
		await page.keyboard.press('Escape');
		// The page's client id is whatever sent its first message.
		await waitUntil(() => received.length > before);

		return { context, page, client: received.at(-1)?.client ?? '' };
	};

	it('hold Space → ptt_start carries the device rate, ~100 ms frames at that rate, one ptt_stop after the tail', async () => {
		const { context, page, client } = await openMicTab();
		const firstChunk = audioChunks.length;
		await page.keyboard.down('Space');
		await Bun.sleep(1200);
		await page.keyboard.up('Space');
		await waitUntil(() => listFromClient(client, 'ptt_stop').length === 1);
		await Bun.sleep(300);

		const starts = listFromClient(client, 'ptt_start');
		expect(starts).toHaveLength(1);
		expect(listFromClient(client, 'ptt_stop')).toHaveLength(1);
		const rate = (starts[0]!.message as { sampleRate?: number }).sampleRate ?? 0;
		expect(rate).toBeGreaterThanOrEqual(16000);
		const frames = audioChunks.slice(firstChunk);
		expect(frames.length).toBeGreaterThan(8);
		// A live frame is ~100 ms at the device rate (flushed on 128-sample quanta).
		const frame = frames.at(-1) ?? 0;
		expect(frame).toBeGreaterThanOrEqual((rate / 10) * 2);
		expect(frame).toBeLessThan((rate / 10) * 2 + 256);
		await context.close();
	}, 20_000);

	it('mic stays open: the next press opens no new device, and a quick tap still carries the pre-roll and the tail', async () => {
		const { context, page, client } = await openMicTab();
		await page.keyboard.down('Space');
		await Bun.sleep(400);
		await page.keyboard.up('Space');
		await waitUntil(() => listFromClient(client, 'ptt_stop').length === 1);
		await Bun.sleep(600);

		const tapStart = audioChunks.length;
		await page.keyboard.down('Space');
		await page.keyboard.up('Space');
		await waitUntil(() => listFromClient(client, 'ptt_stop').length === 2);

		const rate =
			(listFromClient(client, 'ptt_start')[1]!.message as { sampleRate?: number }).sampleRate ?? 0;
		const bytes = audioChunks.slice(tapStart).reduce((total, chunk) => total + chunk, 0);
		// 300 ms before the press plus 250 ms after the release.
		expect(bytes / 2 / rate).toBeGreaterThan(0.45);
		expect(await page.evaluate(() => (window as unknown as { __gum: number }).__gum)).toBe(1);
		expect(listFromClient(client, 'ptt_start')).toHaveLength(2);
		await context.close();
	}, 20_000);

	it('hands-free chosen → echo-cancelled mic, listen_start at the device rate with the mode, audio with no key held; Space starts no press; push to talk → listen_stop', async () => {
		const { context, page, client } = await openMicTab();
		await chooseMode(page, 'Hands-free');
		await waitUntil(() => listFromClient(client, 'listen_start').length === 1);
		const firstChunk = audioChunks.length;
		await Bun.sleep(600);
		expect(audioChunks.length - firstChunk).toBeGreaterThan(3);
		expect(await readMode(page)).toBe('hands-free');
		const start = listFromClient(client, 'listen_start')[0]!.message as {
			sampleRate: number;
			mode: string;
		};
		expect(start.sampleRate).toBeGreaterThanOrEqual(16000);
		expect(start.mode).toBe('hands-free');
		expect(
			await page.evaluate(() => (window as unknown as { __echo: unknown[] }).__echo.at(-1)),
		).toBe(true);

		await page.locator('body').click();
		await page.keyboard.down('Space');
		await Bun.sleep(200);
		await page.keyboard.up('Space');
		await Bun.sleep(400);
		expect(listFromClient(client, 'ptt_start')).toHaveLength(0);

		await chooseMode(page, 'Push to talk');
		await waitUntil(() => listFromClient(client, 'listen_stop').length === 1);
		// Back to the raw mic for push-to-talk.
		await page.waitForFunction(
			() => (window as unknown as { __echo: unknown[] }).__echo.at(-1) === false,
			null,
			{ timeout: 5000 },
		);
		await context.close();
	}, 20_000);

	it('hands-free, then on demand from the menu → the stream reopens in the new mode', async () => {
		const { context, page, client } = await openMicTab();
		await chooseMode(page, 'Hands-free');
		await waitUntil(() => listFromClient(client, 'listen_start').length === 1);

		await chooseMode(page, 'On demand');
		await waitUntil(() => listFromClient(client, 'listen_start').length === 2);
		expect(listFromClient(client, 'listen_stop')).toHaveLength(1);
		expect((listFromClient(client, 'listen_start').at(-1)!.message as { mode: string }).mode).toBe(
			'on-demand',
		);
		expect(
			await page
				.getByRole('textbox', { name: 'Say or type a command' })
				.getAttribute('placeholder'),
		).toContain('Say “Voice OS”');
		await context.close();
	}, 20_000);

	it('server turns listening off (another tab took it) → back to push to talk; a reload of the tab keeps its own choice', async () => {
		const { context, page, client } = await openMicTab();
		await chooseMode(page, 'Hands-free');
		await waitUntil(() => listFromClient(client, 'listen_start').length === 1);
		const listListenStarts = () =>
			received.filter((entry) => entry.message.type === 'listen_start');
		const before = listListenStarts().length;
		await page.reload();
		await page.waitForSelector('.topbar');
		await waitUntil(() => listListenStarts().length > before);
		const reloadedClient = listListenStarts().at(-1)?.client ?? '';
		expect(reloadedClient).not.toBe(client);

		gateway.send(reloadedClient, { type: 'listen_off', reason: 'listening moved to another tab' });
		await page.waitForFunction(
			(value) => document.querySelector('.mode-button')?.getAttribute('data-mode') === value,
			'push',
			{ timeout: 5000 },
		);
		await context.close();
	}, 20_000);

	it('the mode menu → opens on the chosen mode; arrows move, Enter picks, Esc closes back to the button, a click outside closes', async () => {
		const { context, page } = await openMicTab();
		const button = page.getByRole('button', { name: 'Listening mode' });
		const menu = page.getByRole('menu', { name: 'Listening mode' });

		await button.click();
		expect(await menu.getByRole('menuitemradio', { checked: true }).innerText()).toContain(
			'Push to talk',
		);
		expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-checked'))).toBe(
			'true',
		);
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await menu.waitFor({ state: 'detached' });
		expect(await readMode(page)).toBe('dictation');

		await button.click();
		await page.keyboard.press('Escape');
		await menu.waitFor({ state: 'detached' });
		expect(await page.evaluate(() => document.activeElement?.className)).toContain('mode-button');

		await button.click();
		await page.locator('.topbar').click();
		await menu.waitFor({ state: 'detached' });
		expect(await readMode(page)).toBe('dictation');
		await context.close();
	}, 20_000);

	it('the languages you speak → picked in the listening menu, kept by the server', async () => {
		const { context, page } = await openMicTab();
		await page.getByRole('button', { name: 'Listening mode' }).click();
		const slovenian = page.getByRole('menuitemcheckbox', { name: 'Slovenian' });

		expect(
			await page.getByRole('menuitemcheckbox', { name: 'English' }).getAttribute('aria-checked'),
		).toBe('true');
		await slovenian.click();
		await waitUntil(() => store.state.languages.includes('sl'));
		// The page shows it once the server's change comes back.
		await page.waitForFunction(
			() =>
				[...document.querySelectorAll('[role="menuitemcheckbox"]')].some(
					(item) =>
						item.textContent === 'Slovenian' && item.getAttribute('aria-checked') === 'true',
				),
			null,
			{ timeout: 5000 },
		);

		await slovenian.click();
		await waitUntil(() => !store.state.languages.includes('sl'));
		await context.close();
	}, 20_000);

	it('the input grows with the words up to six lines, then scrolls; Shift+Enter is a new line, Enter sends', async () => {
		const { context, page, client } = await openMicTab();
		const field = page.getByRole('textbox', { name: 'Say or type a command' });
		const height = () => field.evaluate((element) => element.getBoundingClientRect().height);
		const oneLine = await height();

		await field.click();
		await page.keyboard.type('first line');
		await page.keyboard.press('Shift+Enter');
		await page.keyboard.type('second line');
		expect(await height()).toBeGreaterThan(oneLine);
		expect(await field.inputValue()).toBe('first line\nsecond line');

		await field.fill(Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n'));
		const capped = await height();
		expect(capped).toBeLessThan(oneLine * 8);
		expect(await field.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
			true,
		);

		await field.fill('run the tests');
		await field.press('Enter');
		await waitUntil(() =>
			listFromClient(client, 'utterance').some(
				(entry) => (entry.message as { text: string }).text === 'run the tests',
			),
		);
		expect(await field.inputValue()).toBe('');
		await context.close();
	}, 20_000);

	it('text over the limit → not sent, kept in the field, and the page says why', async () => {
		const { context, page, client } = await openMicTab();
		const field = page.getByRole('textbox', { name: 'Say or type a command' });
		const sentBefore = listFromClient(client, 'utterance').length;
		const long = 'x'.repeat(20_001);

		await field.fill(long);
		await page
			.getByRole('alert')
			.filter({ hasText: 'Too long to send' })
			.waitFor({ timeout: 5000 });
		expect(await page.getByRole('alert').filter({ hasText: 'Too long' }).textContent()).toBe(
			'Too long to send: 20,001 of 20,000 characters',
		);

		await field.press('Enter');
		await Bun.sleep(200);

		expect(listFromClient(client, 'utterance')).toHaveLength(sentBefore);
		expect(await field.inputValue()).toBe(long);

		await field.fill('short again');
		expect(await page.getByRole('alert').filter({ hasText: 'Too long' }).count()).toBe(0);
		await context.close();
	}, 20_000);

	it('dictation → click the mic starts a dictation press; Send ends it; Space starts one too; the mode is kept across a reload', async () => {
		const { context, page, client } = await openMicTab();
		await chooseMode(page, 'Dictation');
		const mic = page.getByRole('button', { name: 'Start dictating' });

		await mic.click();
		await waitUntil(() => listFromClient(client, 'ptt_start').length === 1);
		expect(listFromClient(client, 'ptt_start')[0]!.message).toMatchObject({ dictation: true });
		// A pause is not an end: it keeps going until Send.
		await Bun.sleep(700);
		expect(listFromClient(client, 'ptt_stop')).toHaveLength(0);
		expect(await page.locator('.dictation-clock').isVisible()).toBe(true);
		expect(await page.locator('.route').innerText()).toBe('Stays in the box');

		await page.getByRole('button', { name: 'Send', exact: true }).click();
		await waitUntil(() => listFromClient(client, 'ptt_stop').length === 1);
		expect(await page.locator('.dictation-clock').count()).toBe(0);

		await page.locator('body').click();
		await page.keyboard.down('Space');
		await page.keyboard.up('Space');
		await waitUntil(() => listFromClient(client, 'ptt_start').length === 2);
		await Bun.sleep(400);
		// Space starts a dictation; letting go of it ends nothing.
		expect(listFromClient(client, 'ptt_stop')).toHaveLength(1);
		await page.getByRole('button', { name: 'Send the dictation' }).click();
		await waitUntil(() => listFromClient(client, 'ptt_stop').length === 2);

		await page.reload();
		await page.waitForSelector('.topbar');
		expect(await readMode(page)).toBe('dictation');
		await context.close();
	}, 20_000);

	it('dictation discarded → nothing heard yet goes at once; with words, a second click confirms; ptt_cancel either way', async () => {
		const { context, page, client } = await openMicTab();
		await chooseMode(page, 'Dictation');
		const mic = page.getByRole('button', { name: 'Start dictating' });

		await mic.click();
		await waitUntil(() => listFromClient(client, 'ptt_start').length === 1);
		await page.getByRole('button', { name: 'Discard' }).click();
		await waitUntil(() => listFromClient(client, 'ptt_cancel').length === 1);

		await mic.click();
		await waitUntil(() => listFromClient(client, 'ptt_start').length === 2);
		store.dispatch({
			type: 'transcript',
			transcript: { text: 'so the retries should back off longer', isFinal: false, target: null },
		});
		const field = page.getByRole('textbox', { name: 'Say or type a command' });
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLTextAreaElement>('footer textarea')?.value ===
				'so the retries should back off longer',
		);
		expect(await field.getAttribute('readonly')).not.toBeNull();

		await page.getByRole('button', { name: 'Discard' }).click();
		await page.getByRole('button', { name: 'Discard all?' }).waitFor();
		expect(listFromClient(client, 'ptt_cancel')).toHaveLength(1);
		await page.getByRole('button', { name: 'Discard all?' }).click();
		await waitUntil(() => listFromClient(client, 'ptt_cancel').length === 2);
		store.dispatch({ type: 'transcript', transcript: null });
		await context.close();
	}, 20_000);

	it('a dictation with nowhere to go comes back into the input, to send from there', async () => {
		const { context, page, client } = await openMicTab();
		gateway.send(client, {
			type: 'dictation_kept',
			text: 'the whole brain dump',
			reason: 'no session on screen',
		});
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLTextAreaElement>('footer textarea')?.value ===
				'the whole brain dump',
		);
		await context.close();
	}, 20_000);

	it('on demand turned on by voice (listen_on) → the menu shows it and the mic streams in that mode; a call shows "listening to you"', async () => {
		const { context, page, client } = await openMicTab();
		const before = listFromClient(client, 'listen_start').length;

		gateway.send(client, { type: 'listen_on', mode: 'on-demand' });
		await page.waitForFunction(
			(value) => document.querySelector('.mode-button')?.getAttribute('data-mode') === value,
			'on-demand',
			{ timeout: 5000 },
		);
		await waitUntil(() => listFromClient(client, 'listen_start').length === before + 1);
		expect((listFromClient(client, 'listen_start').at(-1)!.message as { mode: string }).mode).toBe(
			'on-demand',
		);
		const input = page.getByRole('textbox', { name: 'Say or type a command' });
		expect(await input.getAttribute('placeholder')).toContain('Say “Voice OS”');

		gateway.send(client, { type: 'listen_state', isAwake: true });
		await page.waitForFunction(
			(text) =>
				document
					.querySelector<HTMLTextAreaElement>('footer textarea')
					?.placeholder.includes(text) === true,
			'Listening to you',
			{ timeout: 5000 },
		);
		gateway.send(client, { type: 'listen_state', isAwake: false });
		await page.waitForFunction(
			(text) =>
				document
					.querySelector<HTMLTextAreaElement>('footer textarea')
					?.placeholder.includes(text) === true,
			'Say “Voice OS”',
			{ timeout: 5000 },
		);

		gateway.send(client, { type: 'listen_off', reason: 'turned off by voice' });
		await page.waitForFunction(
			(value) => document.querySelector('.mode-button')?.getAttribute('data-mode') === value,
			'push',
			{ timeout: 5000 },
		);
		await context.close();
	}, 20_000);

	it('compacting → a moving bar with the time at the end of the stream; gone when it ends', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		store.dispatch({ type: 'compacting', ref: 'store-front/main', isCompacting: true });
		const bar = page.getByRole('status', { name: 'compacting context' });
		await bar.getByText('Compacting context…').waitFor({ timeout: 5000 });
		expect(await bar.locator('.bar.indeterminate i').count()).toBe(1);

		store.dispatch({ type: 'compacting', ref: 'store-front/main', isCompacting: false });
		await bar.waitFor({ state: 'detached', timeout: 5000 });
		await context.close();
	}, 20_000);

	it('the setup session → no dev servers panel; a worktree session has one', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'setup' } });
		await page.locator('.cockpit').waitFor({ timeout: 5000 });
		expect(await page.locator('section[aria-label="dev servers"]').count()).toBe(0);

		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		await page.locator('section[aria-label="dev servers"]').waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('a held /clear → a confirm card; Yes approves it, No declines it', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		await ensureIdle('store-front/main');
		const listCommandAnswers = () =>
			received.flatMap((entry) =>
				entry.message.type === 'action' && entry.message.action.type === 'answer_command'
					? [entry.message.action]
					: [],
			);

		store.dispatch({ type: 'send', ref: 'store-front/main', text: '/clear' });
		const card = page.locator('section[aria-label="confirm"]');
		await card.getByText("Clear store-front/main's context?").waitFor({ timeout: 5000 });
		await card.getByRole('button', { name: /No/ }).click();
		await card.waitFor({ state: 'detached', timeout: 5000 });
		await page.getByText('Cancelled /clear.').waitFor({ timeout: 5000 });

		store.dispatch({ type: 'send', ref: 'store-front/main', text: '/compact keep the notes' });
		await card.getByText('/compact keep the notes').waitFor({ timeout: 5000 });
		await card.getByRole('button', { name: /Yes/ }).click();
		await card.waitFor({ state: 'detached', timeout: 5000 });

		expect(listCommandAnswers().map((action) => action.isApproved)).toEqual([false, true]);
		expect(effects).toContain('worker_send');
		store.dispatch({ type: 'turn_ended', ref: 'store-front/main', costUsd: 0, text: '' });
		await context.close();
	}, 20_000);

	it('sub-agents → a panel row with type, description and step; gone when it ends; the Stop button stays put', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		await ensureIdle('checkout-api/main');
		store.dispatch({ type: 'send', ref: 'checkout-api/main', text: 'look around' });
		const stop = page.getByRole('button', { name: /Stop turn/ });
		await stop.waitFor({ timeout: 5000 });
		const stopBefore = await stop.boundingBox();

		store.dispatch({
			type: 'subagent_started',
			ref: 'checkout-api/main',
			taskId: 'ui-t1',
			agentType: 'Explore',
			description: 'Find the retry code',
			isBackground: false,
		});
		store.dispatch({
			type: 'subagent_step',
			ref: 'checkout-api/main',
			taskId: 'ui-t1',
			step: 'read src/retry.ts',
		});
		const panel = page.locator('section[aria-label="sub-agents"]');
		await panel.getByText('▸ read src/retry.ts').waitFor({ timeout: 5000 });
		expect(await panel.getByText('Explore').isVisible()).toBe(true);
		expect(await panel.getByText('Find the retry code').isVisible()).toBe(true);
		expect((await stop.boundingBox())?.y).toBe(stopBefore?.y);

		store.dispatch({ type: 'subagent_ended', ref: 'checkout-api/main', taskId: 'ui-t1' });
		await panel.waitFor({ state: 'detached', timeout: 5000 });
		store.dispatch({ type: 'turn_ended', ref: 'checkout-api/main', costUsd: 0, text: '' });
		await context.close();
	}, 20_000);

	it('long streams → each session opens at its end, stays there as lines arrive, and not once scrolled up', async () => {
		const { context, page } = await signIn();

		const fill = (ref: string, count: number) => {
			for (let index = 0; index < count; index++) {
				store.dispatch({ type: 'assistant_text', ref, text: `${ref} line ${index}` });
			}
		};

		// Past what a session keeps, so both lengths stop at the same cap.
		fill('store-front/main', 450);
		fill('checkout-api/main', 450);

		const stream = page.locator('.stream');
		const distanceFromEnd = () =>
			stream.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);

		const openAtEnd = async (ref: string) => {
			store.dispatch({ type: 'switch_view', view: { kind: 'session', ref } });
			await stream.getByText(`${ref} line 449`).waitFor({ timeout: 5000 });
			await page.waitForFunction(() => {
				const element = document.querySelector('.stream');

				return (
					element !== null && element.scrollHeight - element.scrollTop - element.clientHeight < 2
				);
			});
		};

		await openAtEnd('store-front/main');
		await openAtEnd('checkout-api/main');
		await openAtEnd('store-front/main');

		// At the cap the length no longer changes: the new line still comes into view.
		store.dispatch({ type: 'assistant_text', ref: 'store-front/main', text: 'the newest line' });
		await stream.getByText('the newest line').waitFor({ timeout: 5000 });
		await page.waitForFunction(() => {
			const element = document.querySelector('.stream');

			return (
				element !== null && element.scrollHeight - element.scrollTop - element.clientHeight < 2
			);
		});

		// Scrolled up to read: a new line does not pull them back down.
		await stream.evaluate((element) => {
			element.scrollTop = 0;
		});
		// The scroll event lands a frame later, as it does for a hand on the wheel.
		await Bun.sleep(100);
		store.dispatch({ type: 'assistant_text', ref: 'store-front/main', text: 'while reading' });
		await stream.getByText('while reading').waitFor({ timeout: 5000 });
		await Bun.sleep(100);

		expect(await stream.evaluate((element) => element.scrollTop)).toBe(0);
		expect(await distanceFromEnd()).toBeGreaterThan(100);
		await context.close();
	}, 30_000);

	it("Claude's Markdown renders; the developer's own words stay literal; an aside shows its answer", async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'setup' } });
		store.dispatch({
			type: 'assistant_text',
			ref: 'setup',
			text: '## Report\n\n| file | lines |\n| --- | --- |\n| retry.ts | 42 |\n\nSee [docs](https://example.com).',
		});
		const stream = page.locator('.stream');
		await stream.locator('table td', { hasText: 'retry.ts' }).waitFor({ timeout: 5000 });
		expect(await stream.locator('h2', { hasText: 'Report' }).isVisible()).toBe(true);
		expect(await stream.getByRole('link', { name: 'docs' }).getAttribute('target')).toBe('_blank');

		await ensureIdle('setup');
		store.dispatch({ type: 'send', ref: 'setup', text: 'make it **bold**' });
		await stream.getByText('› make it **bold**').waitFor({ timeout: 5000 });

		store.dispatch({ type: 'send', ref: 'setup', text: 'which file?', aside: true });
		await stream.getByText('asking aside…').waitFor({ timeout: 5000 });
		const itemId =
			store.state.sessions.setup?.stream.find((item) => item.kind === 'aside')?.id ?? '';
		store.dispatch({
			type: 'aside_settled',
			ref: 'setup',
			itemId,
			question: 'which file?',
			status: 'answered',
			answer: 'The **retry** file.',
		});
		await stream.locator('.aside strong', { hasText: 'retry' }).waitFor({ timeout: 5000 });
		store.dispatch({ type: 'turn_ended', ref: 'setup', costUsd: 0, text: '' });
		await context.close();
	}, 20_000);

	it('what a session shows: an image through /media, a doc card, the docs list', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		const name = `${'c'.repeat(32)}.png`;
		store.dispatch({ type: 'image', ref: 'store-front/main', name, alt: 'login page' });
		store.dispatch({
			type: 'doc',
			ref: 'store-front/main',
			url: 'https://claude.ai/code/artifact/ui-doc',
			title: 'Retry plan',
		});
		const stream = page.locator('.stream');

		const image = stream.locator('.shown-image img[alt="login page"]').first();
		await image.waitFor({ state: 'attached', timeout: 5000 });
		expect(await image.getAttribute('src')).toBe(`/media?name=${name}`);
		const card = stream.locator('.doc-card', { hasText: 'Retry plan' }).first();
		expect(await card.getAttribute('href')).toBe('https://claude.ai/code/artifact/ui-doc');
		expect(await page.locator('[aria-label="docs"]').getByText('Retry plan').isVisible()).toBe(
			true,
		);
		await context.close();
	}, 20_000);

	it('"open the doc" where the browser blocks a new tab → a banner to tap, with the link', async () => {
		const { context, page } = await signIn(() => {
			window.open = () => null;
		});

		gateway.broadcast({
			type: 'open_url',
			url: 'https://claude.ai/code/artifact/ui-doc',
			title: 'Retry plan',
		});

		const banner = page.locator('.banner a', { hasText: 'Open Retry plan' });
		await banner.waitFor({ timeout: 5000 });
		expect(await banner.getAttribute('href')).toBe('https://claude.ai/code/artifact/ui-doc');
		await context.close();
	}, 20_000);

	it('"open the doc" where the browser allows it → opened in a new tab, cut off from the cockpit', async () => {
		const { context, page } = await signIn(() => {
			const record = window as unknown as { opened: unknown[] };
			record.opened = [];
			window.open = ((url: string, target: string) => {
				const opened = { url, target, opener: 'cockpit' };
				record.opened.push(opened);

				return opened;
			}) as unknown as typeof window.open;
		});

		gateway.broadcast({
			type: 'open_url',
			url: 'https://claude.ai/code/artifact/ui-doc',
			title: 'Retry plan',
		});

		await page.waitForFunction(
			() => (window as unknown as { opened: unknown[] }).opened.length > 0,
			null,
			{
				timeout: 5000,
			},
		);
		expect(await page.evaluate(() => (window as unknown as { opened: unknown[] }).opened)).toEqual([
			{ url: 'https://claude.ai/code/artifact/ui-doc', target: '_blank', opener: null },
		]);
		expect(await page.locator('.banner', { hasText: 'Open Retry plan' }).count()).toBe(0);
		await context.close();
	}, 20_000);

	it('an open permission docks under the stream: the stream stays on screen', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		store.dispatch({ type: 'assistant_text', ref: 'store-front/main', text: 'push the fix next' });
		store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'ui-dock',
				ref: 'store-front/main',
				at: 3,
				kind: 'permission',
				toolName: 'Bash',
				summary: 'run git push',
				input: { command: 'git push' },
				suggestions: [],
			},
		});
		const dock = page.locator('section[aria-label="permission"]');
		await dock.waitFor({ timeout: 5000 });
		const stream = page.locator('.stream');
		expect(await stream.isVisible()).toBe(true);
		expect(await stream.getByText('push the fix next').isVisible()).toBe(true);
		const [streamBox, dockBox] = [await stream.boundingBox(), await dock.boundingBox()];
		expect((dockBox?.y ?? 0) >= (streamBox?.y ?? 0) + 40).toBe(true);

		await page.getByRole('button', { name: /Yes/ }).click();
		await waitUntil(() => store.state.asks.every((ask) => ask.id !== 'ui-dock'));
		await context.close();
	}, 20_000);

	const listSentActions = (type: Action['type']) =>
		received.flatMap((entry) =>
			entry.message.type === 'action' && entry.message.action.type === type
				? [entry.message.action]
				: [],
		);

	it('plan dock → Approve approves; "Change the plan…" rejects it with the reason', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'ui-plan1',
				ref: 'store-front/main',
				at: 1,
				kind: 'plan',
				input: {},
				plan: 'Add an events table.',
			},
		});
		const dock = page.locator('section[aria-label="plan"]');
		await dock.getByRole('button', { name: /Approve/ }).click();
		await waitUntil(() => listSentActions('answer_plan').length > 0);
		expect(listSentActions('answer_plan').at(-1)).toEqual({
			type: 'answer_plan',
			askId: 'ui-plan1',
			isApproved: true,
		});

		store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'ui-plan2',
				ref: 'store-front/main',
				at: 2,
				kind: 'plan',
				input: {},
				plan: 'Drop the orders table.',
			},
		});
		await dock.getByText('Drop the orders table.').waitFor({ timeout: 5000 });
		await dock.getByLabel('Change the plan…').fill('keep the orders table');
		await dock.getByRole('button', { name: 'Send' }).click();
		await waitUntil(() =>
			listSentActions('answer_plan').some(
				(action) => action.type === 'answer_plan' && action.askId === 'ui-plan2',
			),
		);
		expect(listSentActions('answer_plan').at(-1)).toEqual({
			type: 'answer_plan',
			askId: 'ui-plan2',
			isApproved: false,
			message: 'keep the orders table',
		});
		await context.close();
	}, 20_000);

	it('plan dock → the plan renders as Markdown, not as raw text', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'ui-plan3',
				ref: 'store-front/main',
				at: 3,
				kind: 'plan',
				input: {},
				plan: '## Steps\n\n1. **Add** an events table\n2. Backfill it',
			},
		});
		const quote = page.locator('section[aria-label="plan"] .quote');
		await quote.locator('ol li strong', { hasText: 'Add' }).waitFor({ timeout: 5000 });
		expect(await quote.locator('h2', { hasText: 'Steps' }).isVisible()).toBe(true);
		expect(await quote.getByText('## Steps').count()).toBe(0);
		expect(await quote.evaluate((element) => getComputedStyle(element).whiteSpace)).not.toBe(
			'pre-wrap',
		);
		store.dispatch({ type: 'ask_closed', askId: 'ui-plan3' });
		await context.close();
	}, 20_000);

	it('blocked strip → "Allow it" lets it through once; "Leave it blocked" dismisses it', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		store.dispatch({
			type: 'denied',
			ref: 'store-front/main',
			toolName: 'Bash',
			summary: 'rm -rf dist',
		});
		const strip = page.locator('section[aria-label="denied"]');
		await strip.getByRole('button', { name: /Allow it/ }).click();
		await waitUntil(() => listSentActions('allow_denied').length > 0);

		store.dispatch({
			type: 'denied',
			ref: 'store-front/main',
			toolName: 'Bash',
			summary: 'rm -rf build',
		});
		await strip.getByText(/rm -rf build/).waitFor({ timeout: 5000 });
		await strip.getByRole('button', { name: 'Leave it blocked' }).click();
		await waitUntil(() => listSentActions('dismiss_denial').length > 0);
		expect(store.state.denials).toEqual([]);
		await context.close();
	}, 20_000);

	it('"Allow it" on an idle session → the stream shows "Allowed once" in its own style, not as your words', async () => {
		const { context, page } = await signIn();
		await ensureIdle('checkout-api/main');
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		store.dispatch({
			type: 'denied',
			ref: 'checkout-api/main',
			toolName: 'Bash',
			summary: 'run git push',
		});
		await page
			.locator('section[aria-label="denied"]')
			.getByRole('button', { name: /Allow it/ })
			.click();
		const stream = page.locator('.stream');
		const approval = stream.locator('.line.approval');
		await approval.waitFor({ timeout: 5000 });

		expect(await approval.textContent()).toBe('✓ Allowed once: run git push');
		expect(await stream.getByText(/The user allows this once/).count()).toBe(0);
		store.dispatch({ type: 'turn_ended', ref: 'checkout-api/main', costUsd: 0, text: '' });
		await context.close();
	}, 20_000);

	it('queued message → its x cancels exactly that one; the spoken line shows what Voice OS last said', async () => {
		const { context, page } = await signIn();
		// Whatever state earlier tests left checkout in, a message sent behind a turn waits in its queue.
		store.dispatch({ type: 'start_session', ref: 'checkout-api/main' });
		await waitUntil(
			() =>
				!['stopped', 'starting'].includes(
					store.state.sessions['checkout-api/main']?.status ?? 'stopped',
				),
		);
		store.dispatch({ type: 'send', ref: 'checkout-api/main', text: 'run the tests' });
		store.dispatch({ type: 'send', ref: 'checkout-api/main', text: 'then deploy to staging' });
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		const queued = store.state.sessions['checkout-api/main']?.queue.find(
			(queuedMessage) => queuedMessage.text === 'then deploy to staging',
		);
		const item = page.locator('[aria-label="queued"] .qitem', {
			hasText: 'then deploy to staging',
		});
		await item.getByRole('button', { name: /cancel/ }).click();
		await waitUntil(() => listSentActions('cancel_queued').length > 0);
		expect(listSentActions('cancel_queued').at(-1)).toEqual({
			type: 'cancel_queued',
			ref: 'checkout-api/main',
			queuedId: queued?.id ?? '',
		});

		store.dispatch({
			type: 'spoken',
			text: 'checkout api, main is running the tests.',
			source: 'narrator',
		});
		await page
			.locator('.speech .said', { hasText: 'checkout api, main is running the tests.' })
			.waitFor({ timeout: 5000 });
		store.dispatch({ type: 'turn_ended', ref: 'checkout-api/main', costUsd: 0, text: 'Done.' });
		await context.close();
	}, 20_000);

	it("the spoken line on a session's screen → another session's narration hidden; Voice OS and alerts shown; Mission Control shows all", async () => {
		const { context, page } = await signIn();
		const said = page.locator('.speech .said');
		const speak = (text: string, source: 'narrator' | 'kernel' | 'alert', ref?: string) =>
			store.dispatch({ type: 'spoken', text, source, ...(ref ? { ref } : {}) });
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });

		speak('Store front: the tests pass.', 'narrator', 'store-front/main');
		speak('Checkout: the migration is written.', 'narrator', 'checkout-api/main');
		await said.getByText('Store front: the tests pass.').waitFor({ timeout: 5000 });

		speak('Nothing else is waiting.', 'kernel');
		await said.getByText('Nothing else is waiting.').waitFor({ timeout: 5000 });

		speak('Checkout wants to push. Allow?', 'alert', 'checkout-api/main');
		await said.getByText('Checkout wants to push. Allow?').waitFor({ timeout: 5000 });

		speak('Checkout: pushed.', 'narrator', 'checkout-api/main');
		await Bun.sleep(200);
		expect(await said.innerText()).toBe('Checkout wants to push. Allow?');

		store.dispatch({ type: 'switch_view', view: { kind: 'grid' } });
		await said.getByText('Checkout: pushed.').waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('a turn that needs you → no strip of its own: the question is in the stream, the top bar counts it once', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		store.dispatch({ type: 'assistant_text', ref: 'store-front/main', text: 'Ready: push it?' });
		store.dispatch({
			type: 'narration',
			ref: 'store-front/main',
			needsUser: true,
			text: 'store front asks: push it?',
		});
		await page.locator('.stream', { hasText: 'push it?' }).waitFor({ timeout: 5000 });
		store.dispatch({ type: 'narration', ref: 'store-front/main', needsUser: false, text: '' });

		// One session waiting on you and another's plain update: each counted once, the waiting one not
		// also as an update.
		store.dispatch({ type: 'switch_view', view: { kind: 'grid' } });
		store.dispatch({
			type: 'narration',
			ref: 'checkout-api/main',
			needsUser: true,
			text: 'checkout api asks: merge it?',
		});
		store.dispatch({
			type: 'meanwhile_added',
			ref: 'checkout-api/main',
			kind: 'needs',
			about: 'merge it?',
		});
		store.dispatch({
			type: 'meanwhile_added',
			ref: 'store-front/main',
			kind: 'done',
			about: 'the tests pass',
		});
		await page.getByText('1 waiting on you').waitFor({ timeout: 5000 });
		await page.getByText('1 update waiting').waitFor({ timeout: 5000 });

		store.dispatch({ type: 'narration', ref: 'checkout-api/main', needsUser: false, text: '' });
		store.dispatch({ type: 'play_meanwhile' });
		await context.close();
	}, 20_000);

	const openSpeakerTab = async (): Promise<SpeakerTab> => {
		const { page } = await signIn();
		const before = received.length;
		await page.locator('body').click();
		await page.keyboard.press('Escape');
		await waitUntil(() => received.length > before);
		const client = received.at(-1)?.client ?? '';
		// Done only once the audio has actually played out.
		const done = () =>
			received
				.filter((entry) => entry.client === client && entry.message.type === 'audio_done')
				.map((entry) => (entry.message as { id: string }).id);

		return { page, client, done };
	};

	const createSilence = (seconds: number) =>
		Buffer.alloc(Math.round(seconds * 24_000) * 2).toString('base64');

	it('streamed speech → chunks play back to back, audio_done only after playback ends', async () => {
		const { client, done } = await openSpeakerTab();
		gateway.send(client, {
			type: 'audio',
			id: 'clip-a',
			base64: createSilence(0.4),
			isLast: false,
		});
		gateway.send(client, {
			type: 'audio',
			id: 'clip-a',
			base64: createSilence(0.4),
			isLast: false,
		});
		const ended = Date.now();
		gateway.send(client, { type: 'audio', id: 'clip-a', base64: '', isLast: true });

		await waitUntil(() => done().includes('clip-a'), 5000);
		expect(Date.now() - ended).toBeGreaterThanOrEqual(600);
	});

	it('audio_cancel → the clip stops without audio_done, and the next clip plays at once', async () => {
		const { client, done } = await openSpeakerTab();

		for (let i = 0; i < 4; i++) {
			gateway.send(client, {
				type: 'audio',
				id: 'clip-long',
				base64: createSilence(1),
				isLast: false,
			});
		}

		await Bun.sleep(200);
		gateway.send(client, { type: 'audio_cancel', id: 'clip-long' });
		gateway.send(client, {
			type: 'audio',
			id: 'clip-alert',
			base64: createSilence(0.2),
			isLast: false,
		});
		const sent = Date.now();
		gateway.send(client, { type: 'audio', id: 'clip-alert', base64: '', isLast: true });

		await waitUntil(() => done().includes('clip-alert'), 5000);
		expect(Date.now() - sent).toBeLessThan(1500);
		await Bun.sleep(300);
		expect(done()).not.toContain('clip-long');
	});

	it("the side panel is this screen's voice log: what was said, what Voice OS did and said; Mission Control has its own", async () => {
		const { context, page } = await signIn();
		const loggedAt = Date.now();
		store.dispatch({
			type: 'voice_logged',
			screen: 'grid',
			entry: {
				utterance: 'Open checkout.',
				did: ['switch_view checkout-api/main'],
				reply: '',
				at: loggedAt,
			},
		});
		store.dispatch({
			type: 'voice_logged',
			screen: 'checkout-api/main',
			entry: {
				utterance: 'Run the tests.',
				did: ['forward "Run the tests."'],
				reply: 'Sent.',
				at: loggedAt,
			},
		});
		store.dispatch({
			type: 'voice_logged',
			screen: 'checkout-api/main',
			entry: { utterance: 'Hmm.', did: [], reply: '', at: loggedAt, isIgnored: true },
		});

		store.dispatch({ type: 'switch_view', view: { kind: 'grid' } });
		const home = page.locator('[aria-label="voice log"]');
		await home.getByText('you: Open checkout.').waitFor({ timeout: 5000 });
		expect(await home.innerText()).toContain('→ opened checkout-api/main');

		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		const log = page.locator('[aria-label="voice log"]');
		await log.getByText('you: Run the tests.').waitFor({ timeout: 5000 });
		const text = await log.innerText();
		expect(text).toContain('→ forwarded "Run the tests."');
		expect(text).toContain('◂ “Sent.”');
		expect(text).toContain('· no reply needed');
		expect(text).not.toContain('Open checkout.');
		// Newest first.
		expect(text.indexOf('Hmm.')).toBeLessThan(text.indexOf('Run the tests.'));
		expect(await page.getByText('you asked', { exact: true }).count()).toBe(0);
		await context.close();
	}, 20_000);

	it('elsewhere lists another session at work; clicking it opens that session', async () => {
		const { context, page } = await signIn();
		await ensureIdle('setup');
		store.dispatch({
			type: 'send',
			ref: 'setup',
			text: 'Set up a new worktree wrk3 for the store front.',
		});
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });

		const row = page.locator('[aria-label="elsewhere"] .elsewhere-row', { hasText: 'setup' });
		await row.waitFor({ timeout: 5000 });
		expect(await row.innerText()).toContain('Set up a new worktree wrk3');
		await row.click();
		await waitUntil(() => store.state.view.kind === 'session' && store.state.view.ref === 'setup');
		// On its own screen it is not "elsewhere".
		await page
			.locator('[aria-label="elsewhere"] .elsewhere-row', { hasText: 'setup' })
			.waitFor({ state: 'detached', timeout: 5000 });
		store.dispatch({ type: 'turn_ended', ref: 'setup', costUsd: 0, text: 'Done.' });
		await context.close();
	}, 20_000);

	it('dev servers → a panel in the cockpit and a badge on the tile; a died server shows red', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'grid' } });
		store.dispatch({
			type: 'dev_servers',
			ref: 'checkout-api/main',
			servers: [
				{ name: 'api', port: 51049, url: 'http://localhost:51049', state: 'running', detail: null },
				{ name: 'worker', port: 0, url: null, state: 'died', detail: null },
			],
			isSettled: true,
		});
		const badge = page.locator('.tile[data-ref="checkout-api/main"] .devbadge');
		await badge.waitFor({ timeout: 5000 });
		expect(await badge.innerText()).toMatch(/dev 1\/2/i);
		expect(await badge.getAttribute('class')).toContain('c-crit');

		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		const panel = page.locator('[aria-label="dev servers"]');
		await panel.waitFor({ timeout: 5000 });
		expect(await panel.locator('[data-server="worker"]').getAttribute('data-state')).toBe('died');
		expect(await panel.locator('[data-server="api"] a').getAttribute('href')).toBe(
			'http://localhost:51049',
		);
		await context.close();
	}, 20_000);

	it('panel buttons dispatch the same dev actions as voice; Fix shows only with an offer', async () => {
		const { context, page } = await signIn();
		store.dispatch({
			type: 'dev_servers',
			ref: 'checkout-api/main',
			servers: [{ name: 'worker', port: 0, url: null, state: 'died', detail: null }],
			isSettled: true,
		});
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		const panel = page.locator('[aria-label="dev servers"]');
		await panel.getByRole('button', { name: 'Restart' }).waitFor({ timeout: 5000 });
		expect(await panel.getByRole('button', { name: /^Fix/ }).count()).toBe(0);

		await panel.getByRole('button', { name: 'Restart' }).click();
		await waitUntil(() =>
			received.some(
				(entry) => entry.message.type === 'action' && entry.message.action.type === 'dev_restart',
			),
		);

		store.dispatch({
			type: 'dev_offer',
			offer: { ref: 'checkout-api/main', servers: ['worker'], at: Date.now() },
		});
		const fix = panel.getByRole('button', { name: /^Fix worker/ });
		await fix.waitFor({ timeout: 5000 });
		await fix.click();
		await waitUntil(() =>
			received.some(
				(entry) =>
					entry.message.type === 'action' &&
					entry.message.action.type === 'fix_dev' &&
					entry.message.action.ref === 'checkout-api/main',
			),
		);
		await waitUntil(() => store.state.devOffer === null);
		await fix.waitFor({ state: 'detached', timeout: 5000 });

		await panel.getByRole('button', { name: 'Stop' }).click();
		await waitUntil(() =>
			received.some(
				(entry) => entry.message.type === 'action' && entry.message.action.type === 'dev_stop',
			),
		);
		await panel.getByRole('button', { name: /^Start/ }).waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('press while speech plays → it stops at once and is never reported done', async () => {
		const { client, page, done } = await openSpeakerTab();

		for (let i = 0; i < 3; i++) {
			gateway.send(client, {
				type: 'audio',
				id: 'clip-talk',
				base64: createSilence(1),
				isLast: false,
			});
		}

		gateway.send(client, { type: 'audio', id: 'clip-talk', base64: '', isLast: true });
		await Bun.sleep(200);
		await page.keyboard.down('Space');
		await Bun.sleep(300);
		await page.keyboard.up('Space');
		await Bun.sleep(3500);
		expect(done()).not.toContain('clip-talk');
		await page.context().close();
	}, 20_000);

	it('opening a stopped session only shows it; the first message is what starts it', async () => {
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				createWorktree('setup', true),
				createWorktree('store-front/main'),
				createWorktree('checkout-api/main'),
				createWorktree('admin/main'),
			],
		});
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'grid' } });
		const before = effects.length;
		await page.locator('.tile[data-ref="admin/main"]').click();
		await page.getByText('Not running — your first message starts it.').waitFor({ timeout: 5000 });
		expect(store.state.view).toEqual({ kind: 'session', ref: 'admin/main' });
		expect(store.state.sessions['admin/main']?.status).toBe('stopped');
		expect(effects.slice(before)).not.toContain('worker_start');

		const input = page.getByLabel('Say or type a command');
		await input.fill('run the tests');
		await input.press('Enter');
		// The server routes it as a send, which starts a stopped session (reducer spec).
		await waitUntil(() =>
			received.some(
				(entry) => entry.message.type === 'utterance' && entry.message.text === 'run the tests',
			),
		);
		await context.close();
	}, 20_000);

	it('server restarts under an open page → it reconnects, gets a fresh snapshot, clicks reach the new server', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'grid' } });
		const { context, page } = await signIn();
		const previousPort = gateway.port;
		gateway.stop();
		await page.getByText('Reconnecting to the Voice OS server').waitFor({ timeout: 5000 });

		store.dispatch({
			type: 'rename_session',
			ref: 'checkout-api/main',
			name: 'retry backoff after restart',
		});
		gateway = startServer(previousPort);
		await page.getByText('retry backoff after restart').waitFor({ timeout: 15_000 });

		const before = received.length;
		await page.locator('.tile[data-ref="checkout-api/main"]').click();
		await waitUntil(() =>
			received
				.slice(before)
				.some(
					(entry) => entry.message.type === 'action' && entry.message.action.type === 'switch_view',
				),
		);
		// The store is shared: later tests read this session by its ref.
		store.dispatch({ type: 'rename_session', ref: 'checkout-api/main', name: '' });
		await context.close();
	}, 40_000);
});

describe('pinned', () => {
	const REMOTE = 'vm1:api/main';

	const readTileRefs = (page: Page): Promise<(string | null)[]> =>
		page
			.locator('.tile')
			.evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-ref')));

	const readCrumbs = (page: Page): Promise<string> => page.locator('.topbar .ws').innerText();

	const readTabs = (page: Page): Promise<string[]> => page.locator('.tabs .tab').allInnerTexts();

	const goHome = (): void => {
		store.dispatch({ type: 'switch_view', view: { kind: 'machines' } });
	};

	beforeAll(() => {
		for (const ref of [...store.state.pinned]) {
			store.dispatch({ type: 'unpin_session', ref });
		}

		store.dispatch({ type: 'machines', machines: [{ id: 'vm1', host: 'vm1', name: 'Build box' }] });
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				createWorktree('setup', true),
				createWorktree('store-front/main'),
				createWorktree('checkout-api/main'),
				// Another machine's session is labelled as that machine knows it.
				{ ...createWorktree(REMOTE), label: 'api/main' },
			],
		});
		store.dispatch({ type: 'machine_resynced', id: 'vm1', inputs: [] });
	});

	it('nothing pinned → the Pinned card first on Mission Control, with no status dot', async () => {
		goHome();
		const { context, page } = await signIn();
		const first = page.locator('section.machine').first();

		expect(await first.getAttribute('aria-label')).toBe('Pinned');
		expect(await first.innerText()).toContain('0 sessions');
		expect(await first.innerText()).toContain('Pin a session to keep it here');
		expect(await first.locator('.dot').count()).toBe(0);
		expect(await first.getByRole('button', { name: 'rename' }).count()).toBe(0);
		await context.close();
	}, 20_000);

	it('add a machine → typing the name stays in the name field', async () => {
		goHome();
		const { context, page } = await signIn();

		await page.getByRole('button', { name: /Add machine/ }).click();
		await page.getByLabel('SSH host').pressSequentially('vm2');
		await page.getByLabel('name', { exact: true }).click();
		await page.getByLabel('name', { exact: true }).pressSequentially('Lab box');

		expect(await page.getByLabel('name', { exact: true }).inputValue()).toBe('Lab box');
		expect(await page.getByLabel('SSH host').inputValue()).toBe('vm2');
		await context.close();
	}, 20_000);

	it('pin on a machine grid tile → pinned without opening it; the Pinned card counts it', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'grid', machine: 'local' } });
		const { context, page } = await signIn();
		const tile = page.locator('.tile[data-ref="store-front/main"]');

		await tile.getByRole('button', { name: 'pin', exact: true }).click();
		await waitUntil(() => store.state.pinned.includes('store-front/main'));
		await tile.getByRole('button', { name: 'unpin' }).waitFor({ timeout: 5000 });
		expect(store.state.view).toEqual({ kind: 'grid', machine: 'local' });

		await page.locator('.topbar .crumb', { hasText: 'Mission Control' }).click();
		const card = page.locator('section.machine[aria-label="Pinned"]');
		await card.getByText('1 session').waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('Pinned → the pinned sessions from every machine, in pin order, another machine named', async () => {
		store.dispatch({ type: 'pin_session', ref: REMOTE });
		goHome();
		const { context, page } = await signIn();
		await page.locator('section.machine[aria-label="Pinned"] .machine-name').click();
		await waitUntil(() => store.state.view.kind === 'pinned');
		await page.locator(`.tile[data-ref="${REMOTE}"]`).waitFor({ timeout: 5000 });

		expect(await readTileRefs(page)).toEqual(['store-front/main', REMOTE]);
		expect(await page.locator(`.tile[data-ref="${REMOTE}"] .ref`).innerText()).toBe(
			'Build box · api/main',
		);
		expect(await readCrumbs(page)).toBe('Mission Control › Pinned');
		expect(await page.locator('.topbar').innerText()).toContain('2 sessions');
		await context.close();
	}, 20_000);

	it('a tile on Pinned → the session inside Pinned: Pinned crumbs, the pins as tabs, a tab click stays there', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'pinned' } });
		const { context, page } = await signIn();
		await page.locator('.tile[data-ref="store-front/main"] .tile-open').click();
		await waitUntil(
			() => store.state.view.kind === 'session' && store.state.view.from === 'pinned',
		);
		await page.getByRole('navigation').waitFor({ timeout: 5000 });

		expect(await readCrumbs(page)).toBe('Mission Control › Pinned › store-front/main');
		expect(await readTabs(page)).toEqual([
			expect.stringContaining('store-front/main'),
			expect.stringContaining('Build box · api/main'),
		]);
		expect(await page.locator('.topbar .home').innerText()).toBe('Esc → Pinned');

		await page.locator('.tabs .tab', { hasText: 'api/main' }).click();
		await waitUntil(() => store.state.view.kind === 'session' && store.state.view.ref === REMOTE);
		expect(store.state.view).toEqual({ kind: 'session', ref: REMOTE, from: 'pinned' });
		await context.close();
	}, 20_000);

	it("a pinned session opened from its machine's grid → inside Pinned all the same", async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'grid', machine: 'local' } });
		const { context, page } = await signIn();
		await page.locator('.tile[data-ref="store-front/main"] .ref').click();
		await waitUntil(
			() => store.state.view.kind === 'session' && store.state.view.ref === 'store-front/main',
		);

		expect(store.state.view).toEqual({ kind: 'session', ref: 'store-front/main', from: 'pinned' });
		await page.getByText('Mission Control › Pinned › store-front/main').waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('a pinned session opened from Elsewhere → inside Pinned', async () => {
		await ensureIdle('setup');
		store.dispatch({ type: 'pin_session', ref: 'setup' });
		store.dispatch({ type: 'send', ref: 'setup', text: 'Tidy the old worktrees.' });
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		const { context, page } = await signIn();
		await page
			.locator('[aria-label="elsewhere"] .elsewhere-row', { hasText: 'setup' })
			.click({ timeout: 5000 });
		await waitUntil(() => store.state.view.kind === 'session' && store.state.view.ref === 'setup');

		expect(store.state.view).toEqual({ kind: 'session', ref: 'setup', from: 'pinned' });
		store.dispatch({ type: 'turn_ended', ref: 'setup', costUsd: 0, text: 'Done.' });
		store.dispatch({ type: 'unpin_session', ref: 'setup' });
		await context.close();
	}, 20_000);

	it("the TopBar's pin on an unpinned session → pinned; unpin → gone from the pins", async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		const { context, page } = await signIn();
		await page
			.getByText('Mission Control › This Mac › checkout-api/main')
			.waitFor({ timeout: 5000 });

		await page.locator('.topbar').getByRole('button', { name: 'pin', exact: true }).click();
		await waitUntil(() => store.state.pinned.includes('checkout-api/main'));
		await page.locator('.topbar').getByRole('button', { name: 'unpin' }).click();
		await waitUntil(() => !store.state.pinned.includes('checkout-api/main'));
		await page
			.locator('.topbar')
			.getByRole('button', { name: 'pin', exact: true })
			.waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('a pin whose machine is out of reach → a placeholder tile; its unpin lets it go', async () => {
		store.dispatch({ type: 'machine_status', id: 'vm1', status: 'unreachable' });
		store.dispatch({ type: 'pinned_loaded', refs: ['vm1:api/wrk2'] });
		store.dispatch({ type: 'switch_view', view: { kind: 'pinned' } });
		const { context, page } = await signIn();
		const placeholder = page.locator('.tile.missing[data-ref="vm1:api/wrk2"]');

		await placeholder.waitFor({ timeout: 5000 });
		expect(await placeholder.locator('.ref').innerText()).toBe('api/wrk2 · Build box out of reach');
		await placeholder.getByRole('button', { name: 'unpin' }).click();
		await waitUntil(() => !store.state.pinned.includes('vm1:api/wrk2'));
		await placeholder.waitFor({ state: 'detached', timeout: 5000 });
		store.dispatch({ type: 'machine_resynced', id: 'vm1', inputs: [] });
		await context.close();
	}, 20_000);
});

describe('named sessions', () => {
	const REMOTE = 'vm1:api/main';

	const readCrumbs = (page: Page): Promise<string> => page.locator('.topbar .ws').innerText();

	const renameInTopBar = async (page: Page, name: string): Promise<void> => {
		await page.locator('.topbar').getByRole('button', { name: 'rename' }).click();
		await page.getByLabel('session name').fill(name);
		await page.getByLabel('session name').press('Enter');
	};

	it("rename on another machine's tile → the name alone on the tile, the tab and the crumbs; the ref on hover", async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'pinned' } });
		const { context, page } = await signIn();
		const tile = page.locator(`.tile[data-ref="${REMOTE}"]`);

		await tile.getByRole('button', { name: 'rename' }).click();
		await page.getByLabel('session name').fill('voice os dev');
		await page.getByLabel('session name').press('Enter');
		await waitUntil(() => store.state.names[REMOTE] === 'voice os dev');

		await tile.locator('.ref', { hasText: 'voice os dev' }).waitFor({ timeout: 5000 });
		expect(await tile.locator('.ref').innerText()).toBe('voice os dev');
		expect(await tile.locator('.ref').getAttribute('title')).toBe(REMOTE);
		expect(store.state.view).toEqual({ kind: 'pinned' });

		await tile.locator('.tile-open').click();
		await page.getByText('Mission Control › Pinned › voice os dev').waitFor({ timeout: 5000 });
		expect(await page.locator('.tabs .tab.on').innerText()).toStartWith('voice os dev');
		await context.close();
	}, 20_000);

	it('rename in the TopBar → shown in the crumbs and the tab; a name already taken is refused; empty clears it', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		const { context, page } = await signIn();

		await renameInTopBar(page, 'shop');
		await waitUntil(() => store.state.names['store-front/main'] === 'shop');
		await page.getByText('Mission Control › Pinned › shop').waitFor({ timeout: 5000 });
		expect(await page.locator('.tabs .tab.on').innerText()).toStartWith('shop');

		const before = received.length;
		await renameInTopBar(page, 'Voice OS dev');
		await waitUntil(() =>
			received
				.slice(before)
				.some(
					(entry) =>
						entry.message.type === 'action' && entry.message.action.type === 'rename_session',
				),
		);
		expect(store.state.names['store-front/main']).toBe('shop');
		expect(await readCrumbs(page)).toBe('Mission Control › Pinned › shop');

		await renameInTopBar(page, '');
		await waitUntil(() => store.state.names['store-front/main'] === undefined);
		await page.getByText('Mission Control › Pinned › store-front/main').waitFor({ timeout: 5000 });
		expect(await page.locator('.topbar .ws span[title]').count()).toBe(0);

		store.dispatch({ type: 'rename_session', ref: REMOTE, name: '' });
		await context.close();
	}, 20_000);
});
