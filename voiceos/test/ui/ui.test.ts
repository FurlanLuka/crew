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

const signIn = async (): Promise<SignedInTab> => {
	const context = await browser.newContext({ permissions: ['microphone'] });
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
			createWorktree('voiceos', true),
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

	it('mission control lists every worktree, pinned setup session first', async () => {
		const { context, page } = await signIn();
		const refs = await page
			.locator('.tile')
			.evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-ref')));

		expect(refs).toEqual(['voiceos', 'checkout-api/main', 'store-front/main']);
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

	it('hands-free on → echo-cancelled mic, listen_start at the device rate, audio with no key held; Space starts no press; off → listen_stop', async () => {
		const { context, page, client } = await openMicTab();
		const toggle = page.getByRole('button', { name: 'hands-free' });
		await toggle.click();
		await waitUntil(() => listFromClient(client, 'listen_start').length === 1);
		const firstChunk = audioChunks.length;
		await Bun.sleep(600);
		expect(audioChunks.length - firstChunk).toBeGreaterThan(3);
		expect(await toggle.getAttribute('aria-pressed')).toBe('true');
		expect(
			(listFromClient(client, 'listen_start')[0]!.message as { sampleRate: number }).sampleRate,
		).toBeGreaterThanOrEqual(16000);
		expect(
			await page.evaluate(() => (window as unknown as { __echo: unknown[] }).__echo.at(-1)),
		).toBe(true);

		await page.locator('body').click();
		await page.keyboard.down('Space');
		await Bun.sleep(200);
		await page.keyboard.up('Space');
		await Bun.sleep(400);
		expect(listFromClient(client, 'ptt_start')).toHaveLength(0);

		await toggle.click();
		await waitUntil(() => listFromClient(client, 'listen_stop').length === 1);
		// Back to the raw mic for push-to-talk.
		await page.waitForFunction(
			() => (window as unknown as { __echo: unknown[] }).__echo.at(-1) === false,
			null,
			{ timeout: 5000 },
		);
		await context.close();
	}, 20_000);

	it('server turns hands-free off (another tab took it) → the toggle goes off; a reload of the tab keeps its own choice', async () => {
		const { context, page, client } = await openMicTab();
		const toggle = page.getByRole('button', { name: 'hands-free' });
		await toggle.click();
		await waitUntil(() => listFromClient(client, 'listen_start').length === 1);
		const listListenStarts = () =>
			received.filter((entry) => entry.message.type === 'listen_start');
		const before = listListenStarts().length;
		await page.reload();
		await page.waitForSelector('.topbar');
		await waitUntil(() => listListenStarts().length > before);
		const reloadedClient = listListenStarts().at(-1)?.client ?? '';
		expect(reloadedClient).not.toBe(client);

		gateway.send(reloadedClient, { type: 'listen_off', reason: 'hands-free moved to another tab' });
		await page.waitForSelector('button.handsfree[aria-pressed="false"]', { timeout: 5000 });
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
		await item.getByRole('button').click();
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

	it('a turn that needs you → a slim strip, the stream stays on screen', async () => {
		const { context, page } = await signIn();
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });
		store.dispatch({
			type: 'narration',
			ref: 'store-front/main',
			needsUser: true,
			text: 'store front asks: push it?',
			topic: null,
		});
		const strip = page.locator('section[aria-label="needs you"]');
		await strip.waitFor({ timeout: 5000 });
		expect(await page.locator('.stream').isVisible()).toBe(true);
		expect(((await strip.boundingBox())?.height ?? 999) < 80).toBe(true);
		await strip.getByRole('button', { name: 'Dismiss' }).click();
		await waitUntil(() => store.state.sessions['store-front/main']?.needsUser === null);
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
		store.dispatch({ type: 'start_session', ref: 'voiceos' });
		await waitUntil(() => store.state.sessions.voiceos?.status === 'idle');
		store.dispatch({
			type: 'send',
			ref: 'voiceos',
			text: 'Set up a new worktree wrk3 for the store front.',
		});
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store-front/main' } });

		const row = page.locator('[aria-label="elsewhere"] .elsewhere-row', { hasText: 'voiceos' });
		await row.waitFor({ timeout: 5000 });
		expect(await row.innerText()).toContain('Set up a new worktree wrk3');
		await row.click();
		await waitUntil(
			() => store.state.view.kind === 'session' && store.state.view.ref === 'voiceos',
		);
		// On its own screen it is not "elsewhere".
		await page
			.locator('[aria-label="elsewhere"] .elsewhere-row', { hasText: 'voiceos' })
			.waitFor({ state: 'detached', timeout: 5000 });
		store.dispatch({ type: 'turn_ended', ref: 'voiceos', costUsd: 0, text: 'Done.' });
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
				createWorktree('voiceos', true),
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
			type: 'pin_topic',
			ref: 'checkout-api/main',
			topic: 'Retry backoff after restart',
		});
		gateway = startServer(previousPort);
		await page.getByText('Retry backoff after restart').waitFor({ timeout: 15_000 });

		const before = received.length;
		await page.locator('.tile[data-ref="checkout-api/main"]').click();
		await waitUntil(() =>
			received
				.slice(before)
				.some(
					(entry) => entry.message.type === 'action' && entry.message.action.type === 'switch_view',
				),
		);
		await context.close();
	}, 40_000);
});
