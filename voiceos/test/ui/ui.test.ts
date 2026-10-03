// The real UI bundle and gateway, with a store the test drives instead of Claude workers and the
// fake crew behind /api/crew. Voice OS's half; Set up's is setup.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import index from '../../src/web/index.html';
import { listAllowedOrigins } from '../../src/gateway/auth.js';
import { startGateway, type Gateway } from '../../src/gateway/server.js';
import { configureLog } from '../../src/log.js';
import type { Action, ClientMessage, WorktreeInfo } from '../../src/shared/protocol.js';
import { isActive } from '../../src/shared/active.js';
import { Store } from '../../src/state/store.js';
import { createFakeCrew } from '../support/fake-crew.js';

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
		store.dispatch({ type: 'activate', ref });
	} else if (status === 'running' || status === 'blocked') {
		store.dispatch({ type: 'interrupt', ref });
		store.dispatch({ type: 'turn_ended', ref, costUsd: 0, text: '' });
	}

	await waitUntil(() => store.state.sessions[ref]?.status === 'idle');
};

const crew = createFakeCrew();

const startServer = (port = 0): Gateway => {
	return startGateway({
		runCrew: crew.runCrew,
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
		// No hot reload: its socket would push every file another process saves into pages the test already closed.
		development: false,
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
	// The login lands on Home; Voice OS is /voice, on whatever screen every tab is showing.
	await page.goto(`http://localhost:${gateway.port}/login?token=${TOKEN}`);
	await page.goto(`http://localhost:${gateway.port}/voice`);
	await page.waitForSelector('.vo-top');

	return { context, page };
};

beforeAll(async () => {
	configureLog({ quiet: true });
	store = new Store();
	store.onEffect((effect) => {
		effects.push(effect.type);

		// Stand in for a worker so an activated session reaches idle.
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
	// crew knows checkout-api/main too, with a project that has dev servers: its Dev servers panel
	// shows whether or not they run.
	crew.machines.local?.workspaces.push({
		name: 'checkout-api',
		projects: [{ name: 'store-api', mode: 'worktree' }],
		worktrees: ['main'],
	});
	// Most tests talk to these two; an inactive session has no input box (the 'active' block).
	store.dispatch({ type: 'activate', ref: 'store-front/main' });
	store.dispatch({ type: 'activate', ref: 'checkout-api/main' });
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
	// A test that failed with voice off must not fail every mic test after it.
	if (store.state.voiceOff) {
		store.dispatch({ type: 'set_voice_off', voiceOff: false });
	}

	const errors = pageErrors.splice(0);
	expect(errors).toEqual([]);
});

afterAll(async () => {
	await browser?.close();
	gateway?.stop();
});

describe('voice os ui', () => {
	it('without signing in → the "open crew from a terminal" card, no state', async () => {
		const context = await browser.newContext();
		const page = await context.newPage();
		watchErrors(page);
		await page.goto(`http://localhost:${gateway.port}/`);

		await expect(
			page.getByText('Open crew from a terminal').waitFor({ timeout: 10_000 }),
		).resolves.toBeUndefined();
		await context.close();
	}, 20_000);

	it('Home → Voice OS plays its moment, then Active: one row per active session, never the setup session', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const context = await browser.newContext({ permissions: ['microphone'] });
		const page = await context.newPage();
		watchErrors(page);
		await page.goto(`http://localhost:${gateway.port}/login?token=${TOKEN}`);
		await page.getByRole('main', { name: 'Home' }).waitFor({ timeout: 10_000 });
		expect(await page.locator('.launch-choice').allInnerTexts()).toEqual([
			expect.stringContaining('Voice OS'),
			expect.stringContaining('Set up'),
		]);

		await page.locator('.launch-choice', { hasText: 'Voice OS' }).click();
		await page.locator('.vo-moment .wordmark', { hasText: 'Voice OS' }).waitFor({ timeout: 5000 });
		await page.locator('section[aria-label="Home"]').waitFor({ timeout: 5000 });
		expect(new URL(page.url()).pathname).toBe('/voice');

		const refs = await page
			.locator('.vo-row')
			.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-ref')));
		expect(refs).toEqual(['store-front/main', 'checkout-api/main']);
		expect(await page.locator('.vo-tab[data-ref]').count()).toBe(2);
		await context.close();
	}, 20_000);

	it('Home → Voice OS while voice is off → its moment with "Voice" struck through', async () => {
		store.dispatch({ type: 'set_voice_off', voiceOff: true });
		const context = await browser.newContext({ permissions: ['microphone'] });
		const page = await context.newPage();
		watchErrors(page);
		await page.goto(`http://localhost:${gateway.port}/login?token=${TOKEN}`);
		await page.getByRole('main', { name: 'Home' }).waitFor({ timeout: 10_000 });

		await page.locator('.launch-choice', { hasText: 'Voice OS' }).click();
		await page.locator('.vo-moment .struck', { hasText: 'Voice' }).waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('click a row in one tab → both tabs open that session (server-driven view), and the address follows', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const firstTab = await signIn();
		const secondTab = await signIn();
		await firstTab.page.locator('.vo-row[data-ref="store-front/main"]').click();

		await secondTab.page
			.locator('.vo-tab[aria-current="true"]', { hasText: 'store-front/main' })
			.waitFor({ timeout: 5000 });
		// Active, so it opens inside Active.
		expect(store.state.view).toEqual({ kind: 'session', ref: 'store-front/main', from: 'active' });
		await secondTab.page.waitForURL('**/voice/session/store-front/main');
		await firstTab.context.close();
		await secondTab.context.close();
	}, 20_000);

	it('permission → clicking Yes resolves the ask with allow', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
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

	it('session tabs move by drag and by Alt+arrows; their order is the active set', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const original = [...store.state.active];
		const { context, page } = await signIn();
		const readTabRefs = () =>
			page
				.locator('.vo-tab[data-ref]')
				.evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-ref') ?? ''));
		const at = (ref: string) => store.state.active.indexOf(ref);
		// The page redraws once the server's state reaches it.
		const expectTabsToStart = (refs: string[]) =>
			page.waitForFunction(
				(want) =>
					[...document.querySelectorAll('.vo-tab[data-ref]')]
						.slice(0, want.length)
						.map((tab) => tab.getAttribute('data-ref'))
						.join(' ') === want.join(' '),
				refs,
				{ timeout: 5000 },
			);

		try {
			const [first = '', second = ''] = await readTabRefs();
			const tab = (ref: string) => page.locator(`.vo-tab[data-ref="${ref}"]`);

			// Dropped on the left half of the first tab: it lands before it.
			await tab(second).dragTo(tab(first), { targetPosition: { x: 3, y: 8 } });
			await waitUntil(() => at(second) < at(first));
			await expectTabsToStart([second, first]);

			// Alt+→ moves the focused tab one place along, and it keeps the focus.
			await tab(second).focus();
			await page.keyboard.press('Alt+ArrowRight');
			await waitUntil(() => at(first) < at(second));
			await expectTabsToStart([first, second]);
			expect(await tab(second).evaluate((element) => element === document.activeElement)).toBe(
				true,
			);
			// Nothing else moved the screen.
			expect(store.state.view).toEqual({ kind: 'active' });
		} finally {
			store.dispatch({ type: 'active_loaded', refs: original });
			await context.close();
		}
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
			const probe = window as unknown as {
				__gum: number;
				__echo: unknown[];
				__streams: MediaStream[];
			};
			probe.__gum = 0;
			probe.__echo = [];
			probe.__streams = [];
			const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

			navigator.mediaDevices.getUserMedia = (constraints) => {
				probe.__gum++;
				probe.__echo.push(
					typeof constraints?.audio === 'object' ? constraints.audio.echoCancellation : null,
				);

				return getUserMedia(constraints).then((stream) => {
					probe.__streams.push(stream);

					return stream;
				});
			};
		});
		const page = await context.newPage();
		watchErrors(page);
		await page.goto(`http://localhost:${gateway.port}/login?token=${TOKEN}`);
		await page.goto(`http://localhost:${gateway.port}/voice`);
		await page.waitForSelector('.vo-top');
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

	it('a held press ends when the window loses focus, when the page is hidden, and on a Space key-up in the text box', async () => {
		const { context, page, client } = await openMicTab();
		await page.keyboard.down('Space');
		await waitUntil(() => listFromClient(client, 'ptt_start').length === 1);
		await page.evaluate(() => window.dispatchEvent(new Event('blur')));
		await waitUntil(() => listFromClient(client, 'ptt_stop').length === 1);
		await page.keyboard.up('Space');

		await page.keyboard.down('Space');
		await waitUntil(() => listFromClient(client, 'ptt_start').length === 2);
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
			document.dispatchEvent(new Event('visibilitychange'));
			Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		});
		await waitUntil(() => listFromClient(client, 'ptt_stop').length === 2);
		await page.keyboard.up('Space');

		// Focus moved into the input mid-press: its key-up still ends the press.
		await page.keyboard.down('Space');
		await waitUntil(() => listFromClient(client, 'ptt_start').length === 3);
		await page.locator('textarea').focus();
		await page.keyboard.up('Space');
		await waitUntil(() => listFromClient(client, 'ptt_stop').length === 3);
		expect(listFromClient(client, 'ptt_start')).toHaveLength(3);
		await context.close();
	}, 20_000);

	it('voice off from the top bar → listening stops, "Voice" struck in the moment, no press, typing still sends; back on → listening again, the moment whole', async () => {
		const { context, page, client } = await openMicTab();
		const other = await signIn();
		await chooseMode(page, 'Hands-free');
		await waitUntil(() => listFromClient(client, 'listen_start').length === 1);

		await page.locator('.vo-top').getByRole('button', { name: 'Mute voice' }).click();
		await waitUntil(() => store.state.voiceOff);
		await waitUntil(() => listFromClient(client, 'listen_stop').length === 1);
		await page.locator('.vo-moment .struck').waitFor({ timeout: 5000 });
		// Every tab showing Voice OS plays it; one loaded while voice is off does not.
		await other.page.locator('.vo-moment .struck').waitFor({ timeout: 5000 });
		await other.page.reload();
		await other.page.waitForSelector('.vo-top');
		await Bun.sleep(800);
		expect(await other.page.locator('.vo-moment').count()).toBe(0);
		expect(
			await other.page.locator('.vo-top').getByRole('button', { name: 'Turn voice on' }).count(),
		).toBe(1);
		await other.context.close();
		await page.locator('.vo-bar').getByRole('button', { name: 'Turn voice on' }).waitFor();
		expect(await page.getByRole('button', { name: 'Listening mode' }).count()).toBe(0);

		await page.locator('body').click();
		await page.keyboard.down('Space');
		await Bun.sleep(200);
		await page.keyboard.up('Space');
		await Bun.sleep(300);
		expect(listFromClient(client, 'ptt_start')).toHaveLength(0);
		expect(listFromClient(client, 'listen_start')).toHaveLength(1);

		const field = page.getByRole('textbox', { name: 'Say or type a command' });
		await field.fill('what is running');
		await field.press('Enter');
		await waitUntil(() =>
			received.some(
				(entry) => entry.message.type === 'utterance' && entry.message.text === 'what is running',
			),
		);

		await page.locator('.vo-top').getByRole('button', { name: 'Turn voice on' }).click();
		await waitUntil(() => !store.state.voiceOff);
		// The tab comes back in the mode it had.
		await waitUntil(() => listFromClient(client, 'listen_start').length === 2);
		expect(await readMode(page)).toBe('hands-free');
		await page.locator('.vo-moment').waitFor({ timeout: 5000 });
		expect(await page.locator('.vo-moment .struck').count()).toBe(0);
		await context.close();
	}, 20_000);

	it('push to talk, voice off → the device let go (the recording light out), Space starts nothing; back on → Space talks again', async () => {
		const { context, page, client } = await openMicTab();

		const hold = async () => {
			await page.locator('body').click();
			await page.keyboard.down('Space');
			await Bun.sleep(200);
			await page.keyboard.up('Space');
		};

		await hold();
		await waitUntil(() => listFromClient(client, 'ptt_start').length === 1);

		await page.locator('.vo-top').getByRole('button', { name: 'Mute voice' }).click();
		await page.waitForFunction(
			() =>
				(window as unknown as { __streams: MediaStream[] }).__streams.every((stream) =>
					stream.getTracks().every((track) => track.readyState === 'ended'),
				),
			null,
			{ timeout: 5000 },
		);
		await hold();
		await Bun.sleep(300);
		expect(listFromClient(client, 'ptt_start')).toHaveLength(1);

		await page.locator('.vo-top').getByRole('button', { name: 'Turn voice on' }).click();
		await waitUntil(() => !store.state.voiceOff);
		await hold();
		await waitUntil(() => listFromClient(client, 'ptt_start').length === 2);
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
		await page.waitForSelector('.vo-top');
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
		await page.locator('.vo-top').click();
		await menu.waitFor({ state: 'detached' });
		expect(await readMode(page)).toBe('dictation');
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
		await page.waitForSelector('.vo-top');
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

	it('words kept while something is typed → appended after it, the typed words first', async () => {
		const { context, page, client } = await openMicTab();
		const field = page.getByRole('textbox', { name: 'Say or type a command' });
		await field.fill('check the retries');
		gateway.send(client, {
			type: 'dictation_kept',
			text: 'and the backoff test',
			reason: 'the press reached its limit',
		});
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLTextAreaElement>('footer textarea')?.value ===
				'check the retries and the backoff test',
		);
		await context.close();
	}, 20_000);

	it('a dictation survives leaving the page: blur and a hidden page send no ptt_stop', async () => {
		const { context, page, client } = await openMicTab();
		await chooseMode(page, 'Dictation');
		await page.getByRole('button', { name: 'Start dictating' }).click();
		await waitUntil(() => listFromClient(client, 'ptt_start').length === 1);

		await page.evaluate(() => {
			window.dispatchEvent(new Event('blur'));
			Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
			document.dispatchEvent(new Event('visibilitychange'));
			Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		});
		await Bun.sleep(500);
		expect(listFromClient(client, 'ptt_stop')).toHaveLength(0);
		expect(await page.locator('.dictation-clock').isVisible()).toBe(true);

		await page.getByRole('button', { name: 'Send', exact: true }).click();
		await waitUntil(() => listFromClient(client, 'ptt_stop').length === 1);
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

	it('the setup session never shows in Voice OS: no tab, no row, no screen; a worktree session has its dev servers', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'setup' } });
		await page.locator('section[aria-label="Home"]').waitFor({ timeout: 5000 });
		expect(await page.locator('[data-ref="setup"]').count()).toBe(0);

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

	it("a sub-agent → its Agent row and its card open its transcript, live; Esc closes only it; Space there doesn't talk", async () => {
		const { context, page } = await signIn();
		const ref = 'checkout-api/main';
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref } });
		await ensureIdle(ref);
		store.dispatch({ type: 'send', ref, text: 'find the retry code' });
		store.dispatch({
			type: 'tool',
			ref,
			name: 'Agent',
			summary: 'start a subagent: Find the retry code',
			toolUseId: 'ui-toolu',
		});
		store.dispatch({
			type: 'subagent_started',
			ref,
			taskId: 'ui-t2',
			agentType: 'Explore',
			description: 'Find the retry code',
			isBackground: false,
			toolUseId: 'ui-toolu',
		});
		store.dispatch({
			type: 'subagent_item',
			ref,
			taskId: 'ui-t2',
			item: { kind: 'tool', name: 'Read', summary: 'read src/retry.ts' },
		});

		await page.getByRole('button', { name: /start a subagent: Find the retry code/ }).click();
		const dialog = page.getByRole('dialog', { name: 'sub-agent transcript' });
		await dialog.getByText('read src/retry.ts').waitFor({ timeout: 5000 });
		expect(await dialog.getByText(/running/).isVisible()).toBe(true);

		// Live: a line said while it is open appears there.
		store.dispatch({
			type: 'subagent_item',
			ref,
			taskId: 'ui-t2',
			item: { kind: 'text', text: 'The backoff lives in src/retry.ts.' },
		});
		await dialog.getByText('The backoff lives in src/retry.ts.').waitFor({ timeout: 5000 });

		// Space on the focused Close is the dialog's: it closes it, and never talks.
		const talksBefore = received.filter((entry) => entry.message.type === 'ptt_start').length;
		expect(
			await dialog
				.getByRole('button', { name: 'Close' })
				.evaluate((el) => el === document.activeElement),
		).toBe(true);
		await page.keyboard.down('Space');
		await Bun.sleep(300);
		await page.keyboard.up('Space');
		await dialog.waitFor({ state: 'detached', timeout: 5000 });
		expect(received.filter((entry) => entry.message.type === 'ptt_start')).toHaveLength(
			talksBefore,
		);

		await page.getByRole('button', { name: /start a subagent: Find the retry code/ }).click();
		await dialog.waitFor({ timeout: 5000 });
		await page.keyboard.press('Escape');
		await dialog.waitFor({ state: 'detached', timeout: 5000 });
		// The page's own Esc would go up a level: given time to arrive, the screen stays.
		await Bun.sleep(300);
		expect(store.state.view).toMatchObject({ kind: 'session', ref });

		// Open, then away to another session and back: it does not open again by itself.
		await page.getByRole('button', { name: /start a subagent: Find the retry code/ }).click();
		await dialog.waitFor({ timeout: 5000 });
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		await dialog.waitFor({ state: 'detached', timeout: 5000 });
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref } });
		await page
			.getByRole('button', { name: /start a subagent: Find the retry code/ })
			.waitFor({ timeout: 5000 });
		expect(await dialog.count()).toBe(0);

		// Ended: the card is gone, the row still opens it, now with its report.
		await page.locator('section[aria-label="sub-agents"]').getByRole('button').click();
		await dialog.waitFor({ timeout: 5000 });
		await page.keyboard.press('Escape');
		store.dispatch({ type: 'subagent_ended', ref, taskId: 'ui-t2' });
		await page.getByRole('button', { name: /start a subagent: Find the retry code/ }).click();
		await dialog.getByRole('region', { name: 'report' }).waitFor({ timeout: 5000 });
		expect(await dialog.getByText('done').isVisible()).toBe(true);
		await page.keyboard.press('Escape');

		store.dispatch({ type: 'turn_ended', ref, costUsd: 0, text: '' });
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
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		store.dispatch({
			type: 'assistant_text',
			ref: 'checkout-api/main',
			text: '## Report\n\n| file | lines |\n| --- | --- |\n| retry.ts | 42 |\n\nSee [docs](https://example.com).',
		});
		const stream = page.locator('.stream');
		await stream.locator('table td', { hasText: 'retry.ts' }).waitFor({ timeout: 5000 });
		expect(await stream.locator('h2', { hasText: 'Report' }).isVisible()).toBe(true);
		expect(await stream.getByRole('link', { name: 'docs' }).getAttribute('target')).toBe('_blank');

		await ensureIdle('checkout-api/main');
		store.dispatch({ type: 'send', ref: 'checkout-api/main', text: 'make it **bold**' });
		await stream.getByText('› make it **bold**').waitFor({ timeout: 5000 });

		store.dispatch({ type: 'send', ref: 'checkout-api/main', text: 'which file?', aside: true });
		await stream.getByText('asking aside…').waitFor({ timeout: 5000 });
		const itemId =
			store.state.sessions['checkout-api/main']?.stream.find((item) => item.kind === 'aside')?.id ??
			'';
		store.dispatch({
			type: 'aside_settled',
			ref: 'checkout-api/main',
			itemId,
			question: 'which file?',
			status: 'answered',
			answer: 'The **retry** file.',
		});
		await stream.locator('.aside strong', { hasText: 'retry' }).waitFor({ timeout: 5000 });
		store.dispatch({ type: 'turn_ended', ref: 'checkout-api/main', costUsd: 0, text: '' });
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

		const banner = page.locator('.vo-notice a', { hasText: 'Open Retry plan' });
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
		expect(await page.locator('.vo-notice', { hasText: 'Open Retry plan' }).count()).toBe(0);
		await context.close();
	}, 20_000);

	it('an open permission docks above the voice bar, below the stream that stays on screen', async () => {
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
		const dock = page.locator('.vo-bar > section[aria-label="permission"]');
		await dock.waitFor({ timeout: 5000 });
		const stream = page.locator('.stream');
		expect(await stream.getByText('push the fix next').isVisible()).toBe(true);
		const [streamBox, dockBox] = [await stream.boundingBox(), await dock.boundingBox()];
		expect(dockBox?.y ?? 0).toBeGreaterThanOrEqual(
			(streamBox?.y ?? 0) + (streamBox?.height ?? 0) - 1,
		);
		expect(await page.locator('.vs-state').count()).toBe(0);

		await page.getByRole('button', { name: /Yes/ }).click();
		await waitUntil(() => store.state.asks.every((ask) => ask.id !== 'ui-dock'));
		await context.close();
	}, 20_000);

	it("a question docks below the stream, right above the voice bar's mic row; its X declines it", async () => {
		const { context, page } = await signIn();
		await page.setViewportSize({ width: 1440, height: 900 });
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'ui-decline',
				ref: 'store-front/main',
				at: 4,
				kind: 'question',
				input: {},
				questions: [
					{
						question: 'Keep the old checkout flow behind a flag?',
						multiSelect: false,
						options: [{ label: 'Yes, behind a flag' }, { label: 'No, replace it' }],
					},
				],
			},
		});
		const card = page.locator('section[aria-label="question"]');
		await card.waitFor({ timeout: 5000 });

		const layout = await page.evaluate(() => {
			const dock = document.querySelector('section[aria-label="question"]') as HTMLElement;
			const bar = document.querySelector('.vo-bar') as HTMLElement;
			const stream = document.querySelector('.vo-stream') as HTMLElement;
			const below = dock.nextElementSibling as HTMLElement;

			return {
				isFirstInBar: bar.firstElementChild === dock,
				belowStream: dock.getBoundingClientRect().top >= stream.getBoundingClientRect().bottom - 1,
				flushOnNext: Math.round(
					below.getBoundingClientRect().top - dock.getBoundingClientRect().bottom,
				),
				barBottom: Math.round(bar.getBoundingClientRect().bottom),
				pageScrolls: document.scrollingElement
					? document.scrollingElement.scrollHeight > window.innerHeight
					: false,
			};
		});
		expect(layout).toEqual({
			isFirstInBar: true,
			belowStream: true,
			flushOnNext: 0,
			barBottom: 900,
			pageScrolls: false,
		});

		await page.getByRole('button', { name: 'Decline the question' }).click();
		await waitUntil(() => listSentActions('decline_question').length > 0);
		expect(listSentActions('decline_question').at(-1)).toEqual({
			type: 'decline_question',
			askId: 'ui-decline',
		});
		await card.waitFor({ state: 'detached', timeout: 5000 });
		expect(store.state.asks.some((ask) => ask.id === 'ui-decline')).toBe(false);
		await context.close();
	}, 20_000);

	it('few panels at 1440×900 → the panels and their divider run down to the bottom of the history', async () => {
		const { context, page } = await signIn();
		await page.setViewportSize({ width: 1440, height: 900 });
		await ensureIdle('store-front/main');
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		await page.locator('.vo-panels').waitFor({ timeout: 5000 });

		const layout = await page.evaluate(() => {
			const aside = document.querySelector('.vo-panels') as HTMLElement;
			const stream = document.querySelector('.vo-stream') as HTMLElement;
			const panels = [...aside.children].at(-1) as HTMLElement;
			const style = getComputedStyle(aside);

			return {
				isFewPanels: panels.getBoundingClientRect().bottom < aside.getBoundingClientRect().bottom,
				asideTop: Math.round(aside.getBoundingClientRect().top),
				streamTop: Math.round(stream.getBoundingClientRect().top),
				asideBottom: Math.round(aside.getBoundingClientRect().bottom),
				streamBottom: Math.round(stream.getBoundingClientRect().bottom),
				border: `${style.borderLeftWidth} ${style.borderLeftStyle}`,
			};
		});

		expect(layout.isFewPanels).toBe(true);
		expect(layout.asideTop).toBe(layout.streamTop);
		// The border is the aside's own, so it spans the aside's height, which is the stream's.
		expect(layout.asideBottom).toBe(layout.streamBottom);
		expect(layout.border).toBe('1px solid');
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
		store.dispatch({ type: 'activate', ref: 'checkout-api/main' });
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

	it("the spoken line on a session's screen → another session's narration hidden; Voice OS and alerts shown; Active shows all", async () => {
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

		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		await said.getByText('Checkout: pushed.').waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('a turn that needs you → no strip of its own: the question is in the stream, its Active row says so', async () => {
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
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
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
		// The waiting one says so in its own row, first and with Answer; the updates wait for the quiet, in the moments row.
		await page
			.locator('.vo-row.waiting[data-ref="checkout-api/main"]', { hasText: 'Answer' })
			.waitFor({ timeout: 5000 });
		await page.getByText('2 updates from other sessions').waitFor({ timeout: 5000 });

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

	it("the side panel is this screen's voice log: what was said, what Voice OS did and said; another screen's stays there", async () => {
		const { context, page } = await signIn();
		const loggedAt = Date.now();
		store.dispatch({
			type: 'voice_logged',
			screen: 'home',
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
		// Plain rows like the other panels': no entry line is a card of its own.
		const lines = await log.locator('.entry > *').evaluateAll((elements) =>
			elements.map((element) => {
				const style = getComputedStyle(element);

				return {
					isRow: element.classList.contains('row'),
					background: style.backgroundColor,
					shadow: style.boxShadow,
					radius: style.borderRadius,
				};
			}),
		);
		expect(lines.length).toBeGreaterThan(0);
		expect(new Set(lines.map((line) => JSON.stringify(line)))).toEqual(
			new Set([
				JSON.stringify({
					isRow: true,
					background: 'rgba(0, 0, 0, 0)',
					shadow: 'none',
					radius: '0px',
				}),
			]),
		);
		await context.close();
	}, 20_000);

	it('elsewhere lists another session at work, never the setup session; clicking it opens that session', async () => {
		const { context, page } = await signIn();
		await ensureIdle('checkout-api/main');
		store.dispatch({
			type: 'send',
			ref: 'checkout-api/main',
			text: 'Make the retries back off instead of hammering the provider.',
		});
		store.dispatch({
			type: 'send',
			ref: 'setup',
			text: 'Set up a new worktree wrk3 for the store front.',
		});
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });

		const row = page.locator('[aria-label="elsewhere"] .elsewhere-row', {
			hasText: 'checkout-api/main',
		});
		await row.waitFor({ timeout: 5000 });
		expect(await row.innerText()).toContain('Make the retries back off');
		expect(await page.locator('[aria-label="elsewhere"]').innerText()).not.toContain('wrk3');
		await row.click();
		await waitUntil(
			() => store.state.view.kind === 'session' && store.state.view.ref === 'checkout-api/main',
		);
		// On its own screen it is not "elsewhere".
		await page
			.locator('[aria-label="elsewhere"] .elsewhere-row', { hasText: 'checkout-api/main' })
			.waitFor({ state: 'detached', timeout: 5000 });
		store.dispatch({ type: 'turn_ended', ref: 'checkout-api/main', costUsd: 0, text: 'Done.' });
		store.dispatch({ type: 'turn_ended', ref: 'setup', costUsd: 0, text: 'Done.' });
		await context.close();
	}, 20_000);

	it('dev servers → a panel beside the stream; a died server shows red', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		store.dispatch({
			type: 'dev_servers',
			ref: 'checkout-api/main',
			servers: [
				{ name: 'api', port: 51049, url: 'http://localhost:51049', state: 'running', detail: null },
				{ name: 'worker', port: 0, url: null, state: 'died', detail: null },
			],
			isSettled: true,
		});
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		const panel = page.locator('[aria-label="dev servers"]');
		await panel.waitFor({ timeout: 5000 });
		expect(await panel.locator('[data-server="worker"]').getAttribute('data-state')).toBe('died');
		const link = panel.getByRole('link', { name: 'Open api (localhost:51049)' });
		expect(await link.getAttribute('href')).toBe('http://localhost:51049');
		expect(await link.getAttribute('target')).toBe('_blank');
		// The URL is the link's tooltip, never text in the row.
		expect(await panel.locator('[data-server="api"]').innerText()).not.toContain('localhost');
		await context.close();
	}, 20_000);

	it('the side panels never scroll sideways: long paths, URLs, voice lines and agent names wrap', async () => {
		const ref = 'store-front/overflow';
		const long = (stem: string) => `${stem}${'x'.repeat(160)}`;
		const listed = store.state.order.flatMap((listedRef) => {
			const session = store.state.sessions[listedRef];

			return session
				? [
						{
							ref: listedRef,
							label: session.label,
							branch: session.branch,
							cwd: session.cwd,
							dirs: session.dirs,
							isPinned: session.isPinned,
						},
					]
				: [];
		});
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				...listed,
				{
					ref,
					label: ref,
					branch: `crew/${ref}`,
					cwd: long('/w/store-front/overflow/'),
					dirs: [long('/w/store-front/overflow/store-api/')],
					isPinned: false,
				},
			],
		});
		store.dispatch({ type: 'activate', ref });
		await waitUntil(() => store.state.sessions[ref]?.status === 'idle');
		store.dispatch({
			type: 'dev_servers',
			ref,
			servers: [
				{
					name: long('web-'),
					port: 51050,
					url: `http://${long('store-front-overflow-')}.localhost:51050`,
					state: 'running',
					detail: null,
				},
			],
			isSettled: true,
		});
		store.dispatch({
			type: 'voice_logged',
			screen: ref,
			entry: {
				utterance: long('say-'),
				did: [long('did-')],
				reply: long('reply-'),
				at: Date.now(),
			},
		});
		store.dispatch({ type: 'send', ref, text: 'go' });
		store.dispatch({
			type: 'subagent_started',
			ref,
			taskId: 'ui-wide',
			agentType: long('Explore-'),
			description: long('describe-'),
			isBackground: false,
		});
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref } });

		for (const viewport of [
			{ width: 1440, height: 900 },
			{ width: 1024, height: 768 },
		]) {
			const context = await browser.newContext({ permissions: ['microphone'], viewport });
			const page = await context.newPage();
			watchErrors(page);
			await page.goto(`http://localhost:${gateway.port}/login?token=${TOKEN}`);
			await page.goto(`http://localhost:${gateway.port}/voice`);
			await page.locator('[aria-label="sub-agents"]').waitFor({ timeout: 5000 });
			await page.locator('[aria-label="dev servers"] [data-server]').waitFor({ timeout: 5000 });
			await page.locator('[aria-label="voice log"] .said').waitFor({ timeout: 5000 });
			const panels = await page.locator('.vo-panels').evaluate((element) => ({
				scroll: element.scrollWidth,
				client: element.clientWidth,
				width: element.getBoundingClientRect().width,
			}));
			const split = await page.locator('.vo-split').evaluate((element) => element.clientWidth);

			expect(panels.scroll).toBeLessThanOrEqual(panels.client);
			// The panels keep their column: the stream is not squeezed by them.
			expect(panels.width).toBeLessThan(split / 2);
			await context.close();
		}

		store.dispatch({ type: 'subagent_ended', ref, taskId: 'ui-wide' });
		store.dispatch({ type: 'interrupt', ref });
		store.dispatch({ type: 'deactivate', ref });
		store.dispatch({ type: 'worktrees', worktrees: listed });
	}, 30_000);

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

	it('opening an inactive session only shows it: no input box, and its Activate is what starts it', async () => {
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				createWorktree('setup', true),
				createWorktree('store-front/main'),
				createWorktree('checkout-api/main'),
				createWorktree('admin/main'),
			],
		});
		store.dispatch({ type: 'switch_view', view: { kind: 'activate' } });
		const { context, page } = await signIn();
		const before = effects.length;
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'admin/main' } });
		await page.getByText(/^Not active: its history only/).waitFor({ timeout: 5000 });
		expect(store.state.sessions['admin/main']?.status).toBe('stopped');
		expect(effects.slice(before)).not.toContain('worker_start');
		expect(await page.getByLabel('Say or type a command').count()).toBe(0);

		await page.locator('.vo-bar').getByRole('button', { name: 'Activate' }).click();
		await waitUntil(() => store.state.sessions['admin/main']?.status === 'idle');
		expect(effects.slice(before)).toContain('worker_start');
		await page.getByLabel('Say or type a command').waitFor({ timeout: 5000 });
		store.dispatch({ type: 'deactivate', ref: 'admin/main' });
		await context.close();
	}, 20_000);

	it('New → New session: a dialog; crew makes it on that machine with its folder and name, and its activation waits for it', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();
		await page.locator('.vo-top').getByRole('button', { name: 'New' }).click();
		await page.getByRole('menuitem', { name: /New session/ }).click();
		const dialog = page.getByRole('dialog', { name: 'New session' });
		const form = dialog.getByRole('form', { name: /New session on/ });
		await form.getByRole('textbox', { name: 'Folder' }).fill('~/notes');
		await form.getByRole('textbox', { name: 'Name' }).fill('research');
		await form.getByRole('button', { name: 'Start session' }).click();

		await page
			.locator('.vo-notice', { hasText: /^Started research on / })
			.waitFor({ timeout: 5000 });
		expect(await dialog.count()).toBe(0);
		const made = crew.calls.filter((call) => call.command.type === 'chat_add').at(-1);
		expect(made?.command).toEqual({ type: 'chat_add', dir: '~/notes', name: 'research' });
		await waitUntil(() =>
			store.state.pendingActivations.some((pending) => pending.ref.startsWith('chat/')),
		);
		await context.close();
	}, 20_000);

	it("a plain session's page → Remove asks first; Keep it runs nothing; Remove stops it, crew drops it, its name goes, back to Active", async () => {
		const chat: WorktreeInfo = {
			...createWorktree('chat/3fa9c1'),
			label: 'research',
			branch: '',
			isChat: true,
			chatName: 'research',
		};
		const others = Object.values(store.state.sessions)
			.filter((session) => !session.ref.startsWith('chat/'))
			.map((session) => ({
				ref: session.ref,
				label: session.label,
				branch: session.branch,
				cwd: session.cwd,
				dirs: session.dirs,
				isPinned: session.isPinned,
			}));
		store.dispatch({ type: 'worktrees', worktrees: [...others, chat] });
		store.dispatch({ type: 'activate', ref: 'chat/3fa9c1' });
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'chat/3fa9c1' } });
		const { context, page } = await signIn();
		const head = page.locator('.vo-head');
		const removes = () => crew.calls.filter((call) => call.command.type === 'chat_rm').length;
		const before = removes();

		await head.getByRole('button', { name: 'Remove', exact: true }).click();
		await head.getByRole('button', { name: 'Keep it' }).click();
		expect(removes()).toBe(before);

		await head.getByRole('button', { name: 'Remove', exact: true }).click();
		await head.getByRole('button', { name: 'Remove: its folder stays' }).click();
		await waitUntil(() => store.state.view.kind === 'active');
		expect(crew.calls.filter((call) => call.command.type === 'chat_rm').at(-1)?.command).toEqual({
			type: 'chat_rm',
			id: 'chat/3fa9c1',
		});
		expect(store.state.active).not.toContain('chat/3fa9c1');
		expect(store.state.names['chat/3fa9c1']).toBeUndefined();
		await context.close();
	}, 20_000);

	it('New session with a name another session has → refused in the dialog, crew never asked', async () => {
		store.dispatch({ type: 'rename_session', ref: 'checkout-api/main', name: 'checkout' });
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();

		try {
			const before = crew.calls.filter((call) => call.command.type === 'chat_add').length;
			await page
				.locator('section[aria-label="Home"]')
				.getByRole('button', { name: 'New session' })
				.click();
			const form = page.getByRole('form', { name: /New session on/ });
			await form.getByRole('textbox', { name: 'Name' }).fill('Checkout');
			await form.getByRole('button', { name: 'Start session' }).click();

			await form.getByRole('alert').getByText('A session is already called Checkout.').waitFor({
				timeout: 5000,
			});
			expect(crew.calls.filter((call) => call.command.type === 'chat_add').length).toBe(before);
			await page.keyboard.press('Escape');
			// Focus is back on what opened it.
			await page.waitForFunction(() => {
				const focused = document.activeElement;

				return (
					focused?.matches('section[aria-label="Home"] button') === true &&
					focused.textContent?.trim() === 'New session'
				);
			});
		} finally {
			// A taken name left behind would refuse it in every test after this one.
			store.dispatch({ type: 'rename_session', ref: 'checkout-api/main', name: '' });
			await context.close();
		}
	}, 20_000);

	it("Activate → New session in a folder that is not there: crew's reason, nothing activated", async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'activate' } });
		const { context, page } = await signIn();
		const before = store.state.pendingActivations.length;
		await page
			.locator('section[aria-label="Machines"]')
			.getByRole('button', { name: 'New session' })
			.first()
			.click();
		const form = page.getByRole('form', { name: /New session on/ });
		await form.getByRole('textbox', { name: 'Folder' }).fill('/missing/place');
		await form.getByRole('button', { name: 'Start session' }).click();

		// The dialog stays open with crew's own words; Cancel leaves without a line.
		await form.getByText(/no folder \/missing\/place/).waitFor({ timeout: 5000 });
		expect(store.state.pendingActivations.length).toBe(before);
		await form.getByRole('button', { name: 'Cancel' }).click();
		await page.getByRole('dialog', { name: 'New session' }).waitFor({ state: 'detached' });
		expect(await page.locator('.vo-notice', { hasText: 'Started' }).count()).toBe(0);
		await context.close();
	}, 20_000);

	it("crew's server stops under an open page → the banner says how to start it; it reconnects, gets a fresh snapshot, clicks reach the new server", async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();
		const previousPort = gateway.port;
		gateway.stop();
		const banner = page.locator('.conn', { hasText: "crew's server stopped" });
		await banner.waitFor({ timeout: 5000 });
		expect(await banner.innerText()).toContain('run crew in a terminal');

		store.dispatch({
			type: 'rename_session',
			ref: 'checkout-api/main',
			name: 'retry backoff after restart',
		});
		gateway = startServer(previousPort);
		await page.getByText('retry backoff after restart').first().waitFor({ timeout: 15_000 });
		await banner.waitFor({ state: 'detached', timeout: 5000 });

		const before = received.length;
		await page.locator('.vo-row[data-ref="checkout-api/main"]').click();
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

	it('a deep link reloads onto its screen: /voice/settings and /voice/session/<ref> switch the view', async () => {
		const { context, page } = await signIn();
		await page.goto(`http://localhost:${gateway.port}/voice/settings`);
		await waitUntil(() => store.state.view.kind === 'settings');
		await page.locator('section[aria-label="Voice OS settings"]').waitFor({ timeout: 5000 });

		await page.goto(`http://localhost:${gateway.port}/voice/session/checkout-api/main`);
		await waitUntil(
			() => store.state.view.kind === 'session' && store.state.view.ref === 'checkout-api/main',
		);
		await page.locator('.vo-head h1', { hasText: 'checkout-api/main' }).waitFor({ timeout: 5000 });
		await page.reload();
		await page.locator('.vo-head h1', { hasText: 'checkout-api/main' }).waitFor({ timeout: 5000 });
		await context.close();
	}, 20_000);

	it('leaving Voice OS stops listening: the crew mark goes Home and the stream is closed', async () => {
		const { context, page, client } = await openMicTab();
		await chooseMode(page, 'Hands-free');
		await waitUntil(() => listFromClient(client, 'listen_start').length === 1);

		await page.locator('.vo-brand').click();
		await page.getByRole('main', { name: 'Home' }).waitFor({ timeout: 5000 });
		await waitUntil(() => listFromClient(client, 'listen_stop').length >= 1);
		expect(new URL(page.url()).pathname).toBe('/');
		await context.close();
	}, 20_000);
});

describe('active', () => {
	const REMOTE = 'vm1:api/main';

	const readRowRefs = (page: Page): Promise<(string | null)[]> =>
		page.locator('.vo-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-ref')));

	const readTabs = (page: Page): Promise<string[]> =>
		page.locator('.vo-tab[data-ref]').allInnerTexts();

	beforeAll(() => {
		for (const ref of [...store.state.active]) {
			store.dispatch({ type: 'deactivate', ref });
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

	it('nothing activated → Active is empty and offers "Activate a worktree"', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();
		const empty = page.locator('.vo-empty');

		await empty.getByText('Nothing active').waitFor({ timeout: 5000 });
		await empty.getByRole('button', { name: 'Activate a worktree' }).click();
		await waitUntil(() => store.state.view.kind === 'activate');
		await context.close();
	}, 20_000);

	it('Home → a machine card opens its page; New → a machine opens its page too; its New session starts on it', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();
		await page.locator('.vo-machine-card[data-machine="vm1"]').click();
		await waitUntil(
			() => store.state.view.kind === 'activate' && store.state.view.machine === 'vm1',
		);
		await page.locator('.vo-machine-page h1', { hasText: 'Build box' }).waitFor({ timeout: 5000 });

		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		await page.locator('.vo-top').getByRole('button', { name: 'New' }).click();
		await page.getByRole('menuitem', { name: /This Mac/ }).click();
		await waitUntil(
			() => store.state.view.kind === 'activate' && store.state.view.machine === 'local',
		);
		await page.locator('.vo-machine-page h1', { hasText: 'This Mac' }).waitFor({ timeout: 5000 });

		store.dispatch({ type: 'switch_view', view: { kind: 'activate', machine: 'vm1' } });
		await page.getByRole('button', { name: 'New session on Build box' }).click();
		const dialog = page.getByRole('dialog', { name: 'New session' });
		await dialog.getByRole('form', { name: 'New session on Build box' }).waitFor({ timeout: 5000 });
		expect(
			await dialog.getByRole('button', { name: 'Build box' }).getAttribute('aria-pressed'),
		).toBe('true');
		await page.keyboard.press('Escape');
		await dialog.waitFor({ state: 'detached', timeout: 5000 });
		// Esc closed the dialog only: the page stayed on the machine.
		expect(store.state.view).toEqual({ kind: 'activate', machine: 'vm1' });
		await context.close();
	}, 20_000);

	it('the New menu by keyboard: arrows and Enter pick; Esc closes it only, focus back on New', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'activate', machine: 'vm1' } });
		const { context, page } = await signIn();
		const button = page.locator('.vo-top').getByRole('button', { name: 'New' });
		await button.click();
		await page.getByRole('menu', { name: 'New' }).waitFor({ timeout: 5000 });
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await waitUntil(
			() =>
				store.state.view.kind === 'activate' &&
				!('machine' in store.state.view && store.state.view.machine),
		);
		// The address follows the view: wait for it before the server moves on, so the page never
		// sends the old screen back.
		await page.waitForURL(/\/voice\/activate$/);

		store.dispatch({ type: 'switch_view', view: { kind: 'activate', machine: 'vm1' } });
		await page.waitForURL(/\/voice\/activate\/vm1$/);
		await button.click();
		await page.getByRole('menu', { name: 'New' }).waitFor({ timeout: 5000 });
		const mark = received.length;
		await page.keyboard.press('Escape');
		await page.getByRole('menu', { name: 'New' }).waitFor({ state: 'detached', timeout: 5000 });
		expect(await button.evaluate((element) => element === document.activeElement)).toBe(true);

		// The machine page's switcher moves every tab: the view carries the machine.
		await page.locator('.vb-switch').getByRole('button', { name: 'This Mac' }).click();
		await waitUntil(
			() => store.state.view.kind === 'activate' && store.state.view.machine === 'local',
		);
		// The socket keeps order: the switcher's is the only screen change since Esc, so Esc sent none.
		expect(
			received
				.slice(mark)
				.filter(
					(entry) => entry.message.type === 'action' && entry.message.action.type === 'switch_view',
				)
				.map((entry) => (entry.message as { action: unknown }).action),
		).toEqual([{ type: 'switch_view', view: { kind: 'activate', machine: 'local' } }]);
		await context.close();
	}, 20_000);

	it('"New" → Activate a worktree: every worktree by machine; Activate gives it a tab and a row without leaving the page', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();
		await page.locator('.vo-top').getByRole('button', { name: 'New' }).click();
		await page.getByRole('menuitem', { name: /Activate a worktree/ }).click();
		await page.locator('section[aria-label="Machines"]').waitFor({ timeout: 5000 });
		await page.locator('.vb-machine b').nth(1).waitFor({ timeout: 5000 });

		expect(await page.locator('.vb-machine b').allInnerTexts()).toEqual(['This Mac', 'Build box']);
		expect(await page.locator('.vb-lib [data-ref="setup"]').count()).toBe(0);
		const row = page.locator('.vb-lib .box-row[data-ref="store-front/main"]');
		await row.getByRole('button', { name: 'Activate' }).click();
		await waitUntil(() => isActive(store.state, 'store-front/main'));
		await page.locator('.vo-tab[data-ref="store-front/main"]').waitFor({ timeout: 5000 });
		await row.locator('.chip', { hasText: 'active' }).waitFor({ timeout: 5000 });
		expect(store.state.view).toEqual({ kind: 'activate' });

		await page.getByLabel('Find a worktree or topic').fill('api');
		expect(await page.locator('.vb-machine b').allInnerTexts()).toEqual(['This Mac', 'Build box']);
		await page.getByLabel('Find a worktree or topic').fill('store');
		expect(await page.locator('.vb-machine b').allInnerTexts()).toEqual(['This Mac']);
		await context.close();
	}, 20_000);

	it('Active → the active sessions from every machine in the order activated, another machine named', async () => {
		store.dispatch({ type: 'activate', ref: REMOTE });
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();
		await page.locator(`.vo-row[data-ref="${REMOTE}"]`).waitFor({ timeout: 5000 });

		expect(await readRowRefs(page)).toEqual(['store-front/main', REMOTE]);
		expect(await page.locator(`.vo-row[data-ref="${REMOTE}"]`).innerText()).toContain('Build box');
		expect(await page.locator('.vo-head .vo-lead').innerText()).toBe('2 sessions on 2 machines.');
		expect(await readTabs(page)).toEqual([
			expect.stringContaining('store-front/main'),
			expect.stringMatching(/api\/main\s*Build box/),
		]);
		await context.close();
	}, 20_000);

	it('a tab opens its session inside Active; Esc goes back to Active', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();
		await page.locator(`.vo-tab[data-ref="${REMOTE}"]`).click();
		await waitUntil(() => store.state.view.kind === 'session' && store.state.view.ref === REMOTE);
		expect(store.state.view).toEqual({ kind: 'session', ref: REMOTE, from: 'active' });
		await page.locator('.vo-head h1', { hasText: 'api/main' }).waitFor({ timeout: 5000 });

		await page.locator('body').click();
		await page.keyboard.press('Escape');
		await waitUntil(() => store.state.view.kind === 'active');
		await context.close();
	}, 20_000);

	it('an inactive session → its history, no input box; Activate in its header starts it; Deactivate takes it back', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } });
		const { context, page } = await signIn();
		const input = page.getByLabel('Say or type a command');
		await page.locator('.vo-head h1', { hasText: 'checkout-api/main' }).waitFor({ timeout: 5000 });

		// The earlier tests' lines stay readable: inactive is browsable, only not driven.
		expect(await page.locator('.vo-stream .line').count()).toBeGreaterThan(0);
		expect(await input.count()).toBe(0);
		await page
			.locator('.vo-bar')
			.getByText("checkout-api/main isn't active")
			.waitFor({ timeout: 5000 });

		await page.locator('.vo-head').getByRole('button', { name: 'Activate', exact: true }).click();
		await waitUntil(() => isActive(store.state, 'checkout-api/main'));
		await input.waitFor({ timeout: 5000 });

		await page.locator('.vo-head').getByRole('button', { name: 'Deactivate' }).click();
		await waitUntil(() => !isActive(store.state, 'checkout-api/main'));
		await input.waitFor({ state: 'detached', timeout: 5000 });
		expect(store.state.sessions['checkout-api/main']?.status).toBe('stopped');
		await context.close();
	}, 20_000);

	it('an active session whose machine is out of reach → a placeholder row; its Deactivate lets it go', async () => {
		store.dispatch({ type: 'machine_status', id: 'vm1', status: 'unreachable' });
		store.dispatch({ type: 'active_loaded', refs: ['vm1:api/wrk2'] });
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();
		const placeholder = page.locator('.vo-row.missing[data-ref="vm1:api/wrk2"]');

		await placeholder.waitFor({ timeout: 5000 });
		expect(await placeholder.innerText()).toContain('api/wrk2 · Build box out of reach');
		await placeholder.getByRole('button', { name: 'Deactivate' }).click();
		await waitUntil(() => !store.state.active.includes('vm1:api/wrk2'));
		await placeholder.waitFor({ state: 'detached', timeout: 5000 });
		store.dispatch({ type: 'machine_resynced', id: 'vm1', inputs: [] });
		await context.close();
	}, 20_000);

	it('a remote that dropped → the state row says so; a crash → "Claude stopped unexpectedly" and Restart starts it', async () => {
		store.dispatch({ type: 'machine_status', id: 'vm1', status: 'unreachable' });
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: REMOTE } });
		const { context, page } = await signIn();
		await page.locator('.vs-state', { hasText: 'Build box dropped' }).waitFor({ timeout: 5000 });
		store.dispatch({ type: 'machine_resynced', id: 'vm1', inputs: [] });

		await ensureIdle('store-front/main');
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		store.dispatch({ type: 'worker_exited', ref: 'store-front/main', error: 'exit 1' });
		const crash = page.locator('.vs-state.crit');
		await crash.getByText('Claude stopped unexpectedly').waitFor({ timeout: 5000 });
		await crash.getByRole('button', { name: 'Restart' }).click();
		await waitUntil(() => store.state.sessions['store-front/main']?.status === 'idle');
		await crash.waitFor({ state: 'detached', timeout: 5000 });
		await context.close();
	}, 20_000);

	it('a moment above the spoken line: "Sent to X. Switch there?" → Switch goes there; "For X?" → settle_target', async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();
		store.dispatch({ type: 'offer_switch', ref: 'store-front/main' });
		const offer = page.locator('.vo-offer');
		await offer.getByText('Sent to store-front/main. Switch there?').waitFor({ timeout: 5000 });
		await offer.getByRole('button', { name: 'Switch' }).click();
		await waitUntil(
			() => store.state.view.kind === 'session' && store.state.view.ref === 'store-front/main',
		);

		store.dispatch({
			type: 'ask_which',
			ref: REMOTE,
			screen: 'store-front/main',
			text: 'run the tests',
		});
		await offer.getByText('For api/main?').waitFor({ timeout: 5000 });
		const before = received.length;
		await offer.getByRole('button', { name: 'No, here' }).click();
		await waitUntil(() =>
			received
				.slice(before)
				.some(
					(entry) =>
						entry.message.type === 'action' &&
						entry.message.action.type === 'settle_target' &&
						!entry.message.action.toTarget,
				),
		);
		await context.close();
	}, 20_000);

	it("settings: the gear opens them; a listening mode chosen there is the voice bar's too", async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();
		await page.getByRole('button', { name: 'Voice OS settings' }).click();
		await waitUntil(() => store.state.view.kind === 'settings');
		const settings = page.locator('section[aria-label="Voice OS settings"]');
		await settings.waitFor({ timeout: 5000 });
		expect(await settings.innerText()).toContain('Build box');

		// The gear became the Settings tab; the side menu reaches every section.
		await page.locator('.vo-top .vo-settings', { hasText: 'Settings' }).waitFor({ timeout: 5000 });
		const nav = settings.getByRole('navigation', { name: 'Settings sections' });
		await nav.getByRole('button', { name: 'Keys' }).click();
		// The page scrolled to it, and the menu marks it.
		await page.waitForFunction(() => {
			const rect = document.getElementById('vs-keys')?.getBoundingClientRect();

			return rect !== undefined && rect.top >= 0 && rect.top < window.innerHeight / 2;
		});
		await page.waitForFunction(
			() =>
				document.querySelector('nav[aria-label="Settings sections"] button[aria-current="true"]')
					?.textContent === 'Keys',
		);
		// Scrolled back up by hand, not through the menu: the menu follows the page.
		await page.evaluate(() => document.getElementById('vs-listening')?.scrollIntoView());
		await page.waitForFunction(
			() =>
				document.querySelector('nav[aria-label="Settings sections"] button[aria-current="true"]')
					?.textContent === 'Listening',
		);

		await settings.getByRole('button', { name: /^Dictation/ }).click();
		expect(await readMode(page)).toBe('dictation');
		await settings.getByRole('button', { name: /^Push to talk/ }).click();
		expect(await readMode(page)).toBe('push');

		await settings.getByRole('button', { name: 'Mute voice' }).click();
		await waitUntil(() => store.state.voiceOff);
		await settings.locator('#vs-voice').getByRole('button', { name: 'Turn voice on' }).click();
		await waitUntil(() => !store.state.voiceOff);
		await context.close();
	}, 20_000);

	it("settings → Discord: the messages channel is picked from the server's channels and saved through crew", async () => {
		store.dispatch({
			type: 'discord_presence',
			presence: {
				isConnected: true,
				isOwnerIn: true,
				isHearing: true,
				channelName: 'Voice OS',
				mode: 'hands-free',
			},
		});
		store.dispatch({ type: 'switch_view', view: { kind: 'settings' } });
		const { context, page } = await signIn();
		const picker = page.getByRole('combobox', { name: 'Messages channel' });
		await picker.waitFor({ timeout: 5000 });
		await picker
			.locator('option', { hasText: '#general' })
			.waitFor({ state: 'attached', timeout: 5000 });

		expect(await picker.locator('option').allInnerTexts()).toEqual(["Voice OS's chat", '#general']);
		expect(await picker.inputValue()).toBe('1001');
		await picker.selectOption('voice');
		await waitUntil(() =>
			crew.calls.some(
				(call) => call.command.type === 'discord_text_channel' && call.command.channel === 'voice',
			),
		);

		store.dispatch({ type: 'discord_presence', presence: null });
		await context.close();
	}, 20_000);

	it('"Not now" → the sheet closes and Voice OS stays, its keys notice kept; the server dropping stacks its banner with it, never over it', async () => {
		store.dispatch({ type: 'setup', missing: ['/k/anthropic.key', '/k/soniox.key'] });
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });

		for (const viewport of [
			{ width: 1280, height: 800 },
			{ width: 390, height: 844 },
		]) {
			const context = await browser.newContext({ permissions: ['microphone'], viewport });
			const page = await context.newPage();
			watchErrors(page);
			await page.goto(`http://localhost:${gateway.port}/login?token=${TOKEN}`);
			await page.goto(`http://localhost:${gateway.port}/voice`);
			const sheet = page.getByRole('dialog', { name: 'Before you talk' });
			await sheet.waitFor({ timeout: 5000 });
			await sheet.getByRole('button', { name: 'Not now' }).click();
			await sheet.waitFor({ state: 'detached', timeout: 5000 });

			expect(new URL(page.url()).pathname).toBe('/voice');
			const notice = page.locator('.vo-notice', { hasText: 'Voice is off until its keys are set' });
			await notice.getByRole('button', { name: 'Add them' }).waitFor({ timeout: 5000 });

			const previousPort = gateway.port;
			gateway.stop();
			const banner = page.locator('.conn', { hasText: "crew's server stopped" });
			await banner.waitFor({ timeout: 5000 });
			const [bannerBox, noticeBox] = await Promise.all([
				banner.boundingBox(),
				notice.boundingBox(),
			]);
			expect(bannerBox && noticeBox && bannerBox.y + bannerBox.height <= noticeBox.y + 0.5).toBe(
				true,
			);
			expect(bannerBox && bannerBox.x >= 0 && bannerBox.x + bannerBox.width <= viewport.width).toBe(
				true,
			);

			gateway = startServer(previousPort);
			await banner.waitFor({ state: 'detached', timeout: 15_000 });

			// The reload a server restart brings: "Not now" still holds for this tab — the notice,
			// shown only while the sheet is closed, is what the page opens on.
			await page.reload();
			await notice.getByRole('button', { name: 'Add them' }).waitFor({ timeout: 5000 });
			expect(await sheet.count()).toBe(0);
			await context.close();
		}

		store.dispatch({ type: 'setup', missing: [] });
	}, 60_000);

	it('a key Voice OS lacks → "Before you talk"; a rejected key says crew\'s own words and saves nothing', async () => {
		store.dispatch({ type: 'setup', missing: ['/k/anthropic.key'] });
		store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		const { context, page } = await signIn();
		const sheet = page.getByRole('dialog', { name: 'Before you talk' });
		await sheet.waitFor({ timeout: 5000 });
		await sheet.getByPlaceholder('sk-ant-…').fill('sess-not-an-api-key');
		await sheet.getByRole('button', { name: 'Start Voice OS' }).click();
		await sheet.getByText('rejected that key').waitFor({ timeout: 5000 });

		await sheet.getByPlaceholder('sk-ant-…').fill('sk-ant-api03-good');
		await sheet.getByRole('button', { name: 'Start Voice OS' }).click();
		await sheet.waitFor({ state: 'detached', timeout: 5000 });
		expect(crew.calls.filter((call) => call.command.type === 'keys_set')).toHaveLength(2);
		store.dispatch({ type: 'setup', missing: [] });
		await context.close();
	}, 20_000);
});

describe('named sessions', () => {
	const REMOTE = 'vm1:api/main';

	it("rename in a session's header → the name on its tab, its row and its header; the ref on hover; empty clears it", async () => {
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: REMOTE } });
		const { context, page } = await signIn();

		await page.locator('.vo-head').getByRole('button', { name: 'Rename' }).click();
		await page.getByLabel('session name').fill('voice os dev');
		await page.getByLabel('session name').press('Enter');
		await waitUntil(() => store.state.names[REMOTE] === 'voice os dev');

		await page.locator('.vo-head h1', { hasText: 'voice os dev' }).waitFor({ timeout: 5000 });
		expect(await page.locator('.vo-head h1').getAttribute('title')).toBe(REMOTE);
		// A name stands alone: no machine beside it.
		expect(await page.locator(`.vo-tab[data-ref="${REMOTE}"]`).innerText()).toBe('voice os dev');

		await page.locator('.vo-head').getByRole('button', { name: 'Rename' }).click();
		await page.getByLabel('session name').fill('');
		await page.getByLabel('session name').press('Enter');
		await waitUntil(() => store.state.names[REMOTE] === undefined);
		await context.close();
	}, 20_000);
});

describe('layout', () => {
	it('a session at 1440×900: only the history scrolls; header, panels and the voice bar stay put', async () => {
		store.dispatch({ type: 'activate', ref: 'store-front/main' });
		await ensureIdle('store-front/main');

		for (let index = 0; index < 120; index++) {
			store.dispatch({
				type: 'assistant_text',
				ref: 'store-front/main',
				text: `layout line ${index}`,
			});
		}

		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		const { context, page } = await signIn();
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.getByText('layout line 119').waitFor({ timeout: 5000 });

		const sizes = await page.evaluate(() => {
			const stream = document.querySelector('.vo-stream') as HTMLElement;
			const bar = document.querySelector('.vo-bar') as HTMLElement;

			return {
				pageScrolls: document.scrollingElement
					? document.scrollingElement.scrollHeight > window.innerHeight
					: false,
				streamScrolls: stream.scrollHeight > stream.clientHeight,
				barBottom: Math.round(bar.getBoundingClientRect().bottom),
				headTop: Math.round(
					(document.querySelector('.vo-head') as HTMLElement).getBoundingClientRect().top,
				),
			};
		});

		expect(sizes).toMatchObject({ pageScrolls: false, streamScrolls: true, barBottom: 900 });
		await page.locator('.vo-stream').hover();
		await page.mouse.wheel(0, -2000);
		await Bun.sleep(200);
		expect(
			await page.evaluate(() =>
				Math.round((document.querySelector('.vo-head') as HTMLElement).getBoundingClientRect().top),
			),
		).toBe(sizes.headTop);
		await context.close();
	}, 20_000);

	it('a phone (390 wide): one column, nothing wider than the screen, the voice bar docked, the mode menu stepped aside', async () => {
		// Enough active tabs to overflow 390px whatever earlier tests left active; taken back after.
		const listed = store.state.order.flatMap((ref) => {
			const session = store.state.sessions[ref];

			return session && !ref.includes(':')
				? [
						{
							ref,
							label: session.label,
							branch: session.branch,
							cwd: session.cwd,
							dirs: session.dirs,
							isPinned: session.isPinned,
						},
					]
				: [];
		});
		const extra = [1, 2, 3, 4].map((n) => `store-front/a-long-feature-branch-${n}`);
		store.dispatch({
			type: 'worktrees',
			worktrees: [...listed, ...extra.map((ref) => createWorktree(ref))],
		});

		for (const ref of extra) {
			store.dispatch({ type: 'activate', ref });
		}

		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		const context = await browser.newContext({
			permissions: ['microphone'],
			viewport: { width: 390, height: 844 },
			hasTouch: true,
			isMobile: true,
		});
		const page = await context.newPage();
		watchErrors(page);
		await page.goto(`http://localhost:${gateway.port}/login?token=${TOKEN}`);
		await page.goto(`http://localhost:${gateway.port}/voice`);
		await page.locator('.vo-head h1').waitFor({ timeout: 5000 });

		const layout = await page.evaluate(() => ({
			width: document.documentElement.scrollWidth,
			split: getComputedStyle(
				document.querySelector('.vo-split') as HTMLElement,
			).gridTemplateColumns.split(' ').length,
			barBottom: Math.round(
				(document.querySelector('.vo-bar') as HTMLElement).getBoundingClientRect().bottom,
			),
			mode: getComputedStyle(document.querySelector('.mode-wrap') as HTMLElement).display,
		}));

		expect(layout).toEqual({ width: 390, split: 1, barBottom: 844, mode: 'none' });

		// The active tabs scroll; "New" stays in the bar, on top, whatever they add up to.
		const add = await page.evaluate(() => {
			const button = document.querySelector('.vo-new') as HTMLElement;
			const rect = button.getBoundingClientRect();
			const tabs = document.querySelector('.vo-tabs') as HTMLElement;

			return {
				isOverflowing: tabs.scrollWidth > tabs.clientWidth,
				isInside: rect.left >= 0 && rect.right <= window.innerWidth,
				isOnTop: button.contains(
					document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
				),
			};
		});
		expect(add).toEqual({ isOverflowing: true, isInside: true, isOnTop: true });
		await context.close();

		for (const ref of extra) {
			store.dispatch({ type: 'deactivate', ref });
		}

		store.dispatch({ type: 'worktrees', worktrees: listed });
	}, 20_000);
});
