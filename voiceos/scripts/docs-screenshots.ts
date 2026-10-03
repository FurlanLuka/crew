// The screenshots in docs/images/voice-os/ and docs/images/setup/, rendered from the real page and a
// made-up state.
//
// Rerun after a UI change that the docs show (Home, a Voice OS view, a Set up page): `bun run
// docs:screenshots` from voiceos/. The state goes through the real reducer, the page is the real
// bundle behind the real gateway on a random localhost port, crew is the fake the UI tests use
// (crew's own JSON shapes, from voiceos/testdata/), and Chromium is Playwright's. Nothing reads or
// writes ~/.crew, no session, key or API is involved, and nothing leaves the machine: the page uses
// the system font.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { RunSetupCommand } from '../src/crew/api.js';
import index from '../src/web/index.html';
import { listAllowedOrigins } from '../src/gateway/auth.js';
import { startGateway, type Gateway } from '../src/gateway/server.js';
import { configureLog } from '../src/log.js';
import {
	HOME_SCREEN,
	type Input,
	type PendingAsk,
	type State,
	type View,
} from '../src/shared/protocol.js';
import { createInitialState, reduce } from '../src/state/reducer.js';
import { Store } from '../src/state/store.js';
import { createFakeCrew, type FakeCrew } from '../test/support/fake-crew.js';

const IMAGES_DIR = join(import.meta.dir, '..', '..', 'docs', 'images');
const TOKEN = 'd'.repeat(64);
const VIEWPORT = { width: 1440, height: 900 };
// This Mac's checkouts, and the build box's: a tile shows its machine's own kind of path.
const LOCAL_HOME = '/Users/dev/code';
const REMOTE_HOME = '/home/dev/code';
const REMOTE = 'store-vm';
const OFFLINE = 'lab-vm';

// The page is served a fixed state: every tab that connects gets this snapshot, and nothing changes it.
// Not a real Store fed by dispatch: its clock stamps every input "now", while a shot needs each input
// backdated (play), and one gateway serves every shot, so each swaps in its own freshly played state.
class SnapshotStore extends Store {
	snapshot: State = createInitialState();

	override get state(): State {
		return this.snapshot;
	}
}

interface Step {
	input: Input;
	secondsAgo: number;
}

// Inputs in the order they happened, each stamped that many seconds before the shot.
const play = (steps: Step[], start = createInitialState()): State => {
	let state = start;

	for (const { input, secondsAgo } of steps) {
		const seq = state.seq + 1;
		const at = Date.now() - secondsAgo * 1000;

		state = reduce(state, { seq, at, id: `i${seq}`, input }).state;
	}

	return state;
};

// A timeline builder: each call is one input, `at` seconds ago.
const timeline = () => {
	const steps: Step[] = [];

	const at = (secondsAgo: number, ...inputs: Input[]) => {
		for (const input of inputs) {
			steps.push({ input, secondsAgo });
		}
	};

	return { steps, at };
};

// What was said to Voice OS on a screen: logged when it was said, so its time and the log's agree.
const logVoice = (
	screen: string,
	utterance: string,
	did: string[],
	secondsAgo: number,
	reply = '',
): Step => ({
	input: {
		type: 'voice_logged',
		screen,
		entry: { utterance, reply, did, at: Date.now() - secondsAgo * 1000 },
	},
	secondsAgo,
});

// isPinned is the setup flag on the wire; the name predates the active set.
const worktree = (ref: string, label = ref, isSetup = false) => {
	const isRemote = ref.includes(':');
	const local = isRemote ? (ref.split(':')[1] ?? ref) : ref;
	const home = isRemote ? REMOTE_HOME : LOCAL_HOME;

	return {
		ref,
		label,
		branch: isSetup ? '' : `crew/${local}`,
		cwd: isSetup ? home : `${home}/${local}`,
		dirs: [],
		isPinned: isSetup,
	};
};

const STORAGE_QUESTION: PendingAsk = {
	id: 'ask-storage',
	ref: 'signals/wrk1',
	at: Date.now() - 60_000,
	kind: 'question',
	input: {},
	questions: [
		{
			question: 'Where should the click events be stored?',
			multiSelect: false,
			options: [
				{
					label: 'New events table',
					description: 'Append-only, one row per click, partitioned by day',
				},
				{
					label: 'Reuse the orders table',
					description: 'No new table; clicks sit next to purchases',
				},
				{
					label: 'Keep them in memory for now',
					description: 'Decide on storage after a week of data',
				},
			],
		},
	],
};

interface WorldOptions {
	// signals/wrk1 asks through the ask dock mid-turn, instead of in words at the end of it.
	isSignalsAsking?: boolean;
}

// Crew's generic example worktrees on this Mac, and a build box with two sessions of its own.
const buildWorld = ({ isSignalsAsking = false }: WorldOptions = {}): State => {
	const { steps, at } = timeline();

	at(
		3600,
		{ type: 'machines', machines: [{ id: REMOTE, host: `dev@${REMOTE}`, name: 'Build box' }] },
		{
			type: 'worktrees',
			worktrees: [
				worktree('setup', 'setup', true),
				worktree('store-front/main'),
				worktree('checkout-api/main'),
				worktree('signals/wrk1'),
				worktree('admin/main'),
				worktree(`${REMOTE}:setup`, 'setup', true),
				worktree(`${REMOTE}:store-front/wrk2`, 'store-front/wrk2'),
			],
		},
		{ type: 'machine_resynced', id: REMOTE, inputs: [] },
		{ type: 'limits', limits: { sevenDay: 34, fiveHour: 12, resetsAt: null } },
		{
			type: 'active_loaded',
			// Every session that runs below; admin/main stays inactive, so its tile is dimmed.
			refs: [
				'store-front/main',
				'checkout-api/main',
				'signals/wrk1',
				`${REMOTE}:setup`,
				`${REMOTE}:store-front/wrk2`,
			],
		},
		{ type: 'names_loaded', names: { 'checkout-api/main': 'checkout' } },
	);

	for (const ref of [
		'setup',
		'store-front/main',
		'checkout-api/main',
		'signals/wrk1',
		`${REMOTE}:setup`,
		`${REMOTE}:store-front/wrk2`,
	]) {
		at(3500, { type: 'session_started', ref });
	}

	// What earlier turns cost, so a running session's cost is not $0.00.
	for (const [ref, costUsd] of [
		['store-front/main', 0.64],
		['signals/wrk1', 0.12],
		[`${REMOTE}:store-front/wrk2`, 0.51],
	] as const) {
		at(3400, { type: 'turn_ended', ref, costUsd, text: '' });
	}

	// setup: registered a repo and made its worktree, then went quiet.
	at(
		3000,
		{ type: 'send', ref: 'setup', text: 'Add the signals repo to crew and give it a worktree' },
		{ type: 'turn_started', ref: 'setup' },
		{
			type: 'tool',
			ref: 'setup',
			name: 'Bash',
			summary: 'run crew add project signals ~/code/signals',
		},
		{ type: 'tool_result', ref: 'setup', ok: true, summary: 'Added project signals' },
		{ type: 'tool', ref: 'setup', name: 'Read', summary: 'read package.json' },
		{
			type: 'tool',
			ref: 'setup',
			name: 'Bash',
			summary:
				'run crew dev add signals --name=dashboard --cmd="pnpm --filter dashboard dev" --port=5173',
		},
		{ type: 'tool_result', ref: 'setup', ok: true, summary: "Added dev server 'dashboard'" },
		{ type: 'tool', ref: 'setup', name: 'Bash', summary: 'run crew add workspace signals signals' },
		{ type: 'tool_result', ref: 'setup', ok: true, summary: 'Created workspace signals' },
		{
			type: 'assistant_text',
			ref: 'setup',
			text: 'Added **signals** to crew. Its worktree `signals/wrk1` is set up and its dev server answers on :4300.',
		},
		{ type: 'turn_ended', ref: 'setup', costUsd: 0.18, text: '' },
	);

	// store-front/main: building the search box, mid-turn.
	at(
		420,
		{
			type: 'send',
			ref: 'store-front/main',
			text: 'Add a search box to the catalog that filters products as you type',
			isSpoken: true,
		},
		{ type: 'turn_started', ref: 'store-front/main' },
		{
			type: 'assistant_text',
			ref: 'store-front/main',
			text: "I'll put the search box in the catalog header and filter on the client first: the product list is already loaded there.",
		},
		{
			type: 'tool',
			ref: 'store-front/main',
			name: 'Read',
			summary: 'read src/catalog/CatalogPage.tsx',
		},
		{ type: 'tool', ref: 'store-front/main', name: 'Grep', summary: 'search for useProducts' },
		{
			type: 'tool',
			ref: 'store-front/main',
			name: 'Edit',
			summary: 'edit src/catalog/CatalogPage.tsx',
		},
		{
			type: 'diff',
			ref: 'store-front/main',
			filePath: 'src/catalog/CatalogPage.tsx',
			lines: [
				'@@ -18,7 +18,13 @@ export const CatalogPage = () => {',
				'   const { products } = useProducts();',
				'-  const shown = products;',
				"+  const [query, setQuery] = useState('');",
				'+  const shown = filterProducts(products, query);',
				' ',
				'   return (',
				'     <Page title="Catalog">',
				'+      <SearchBox value={query} onChange={setQuery} />',
			],
		},
		{
			type: 'tool',
			ref: 'store-front/main',
			name: 'Write',
			summary: 'write src/catalog/filter-products.ts',
		},
		{ type: 'tool', ref: 'store-front/main', name: 'Bash', summary: 'run bun test catalog' },
		{ type: 'tool_result', ref: 'store-front/main', ok: true, summary: '14 pass' },
		{
			type: 'assistant_text',
			ref: 'store-front/main',
			text: 'Search works in the tests: **14 pass**, including matches by category and a query with no results.',
		},
		{
			type: 'dev_servers',
			ref: 'store-front/main',
			isSettled: true,
			servers: [
				{ name: 'web', port: 4100, url: 'http://localhost:4100', state: 'running', detail: null },
				{ name: 'api', port: 4101, url: 'http://localhost:4101', state: 'running', detail: null },
			],
		},
	);
	at(
		40,
		{
			type: 'tool',
			ref: 'store-front/main',
			name: 'Bash',
			summary: 'run bunx playwright screenshot localhost:4100/catalog?q=mug',
		},
		{
			type: 'text_delta',
			ref: 'store-front/main',
			text: 'Trying it in the browser: typing “mug” leaves the two mugs and the',
		},
	);

	// checkout-api/main: its turn ended with an answer.
	at(
		1500,
		{
			type: 'send',
			ref: 'checkout-api/main',
			text: 'Make the payment retries back off instead of hammering the provider',
		},
		{ type: 'turn_started', ref: 'checkout-api/main' },
		{ type: 'tool', ref: 'checkout-api/main', name: 'Read', summary: 'read src/payments/retry.ts' },
		{ type: 'tool', ref: 'checkout-api/main', name: 'Edit', summary: 'edit src/payments/retry.ts' },
		{ type: 'tool', ref: 'checkout-api/main', name: 'Bash', summary: 'run go test ./payments/...' },
		{
			type: 'assistant_text',
			ref: 'checkout-api/main',
			text: 'Retries now back off from 200 ms to 3.2 s with jitter, and give up after five tries. All 41 payment tests pass.',
		},
		{ type: 'turn_ended', ref: 'checkout-api/main', costUsd: 0.42, text: '' },
		{
			type: 'dev_servers',
			ref: 'checkout-api/main',
			isSettled: true,
			servers: [
				{ name: 'api', port: 4200, url: 'http://localhost:4200', state: 'running', detail: null },
			],
		},
	);

	// signals/wrk1: asks the developer where the clicks should go.
	at(
		900,
		{
			type: 'send',
			ref: 'signals/wrk1',
			text: 'Start recording product clicks so we can rank search results',
		},
		{ type: 'turn_started', ref: 'signals/wrk1' },
		{ type: 'tool', ref: 'signals/wrk1', name: 'Read', summary: 'read src/db/schema.sql' },
		{ type: 'tool', ref: 'signals/wrk1', name: 'Grep', summary: 'search for orders' },
		{ type: 'tool', ref: 'signals/wrk1', name: 'Edit', summary: 'edit src/client/track-click.ts' },
	);

	if (isSignalsAsking) {
		at(
			60,
			{
				type: 'assistant_text',
				ref: 'signals/wrk1',
				text: 'The click tracking is wired up in the client. One decision before I write the storage:',
			},
			{ type: 'ask_opened', ask: STORAGE_QUESTION },
		);
	} else {
		at(
			900,
			{
				type: 'assistant_text',
				ref: 'signals/wrk1',
				text: 'The click tracking is wired up in the client. Before I write the storage: should clicks go to a **new events table**, or into the **orders** table next to purchases?',
			},
			{ type: 'turn_ended', ref: 'signals/wrk1', costUsd: 0.21, text: '' },
			{
				type: 'narration',
				ref: 'signals/wrk1',
				needsUser: true,
				text: 'asks: a new events table for clicks, or the orders table?',
			},
		);
	}

	// Build box: its store-front worktree is moving images to the CDN.
	at(
		600,
		{
			type: 'send',
			ref: `${REMOTE}:store-front/wrk2`,
			text: 'Serve the product images from the CDN and keep local ones as the fallback',
		},
		{ type: 'turn_started', ref: `${REMOTE}:store-front/wrk2` },
		{
			type: 'assistant_text',
			ref: `${REMOTE}:store-front/wrk2`,
			text: 'The images are loaded in three places. I will route them through one `imageUrl()` helper so the CDN switch is a single change.',
		},
		{
			type: 'tool',
			ref: `${REMOTE}:store-front/wrk2`,
			name: 'Grep',
			summary: 'search for /images/products',
		},
		{
			type: 'tool',
			ref: `${REMOTE}:store-front/wrk2`,
			name: 'Write',
			summary: 'write src/media/image-url.ts',
		},
		{
			type: 'tool',
			ref: `${REMOTE}:store-front/wrk2`,
			name: 'Edit',
			summary: 'edit src/catalog/ProductCard.tsx',
		},
		{
			type: 'tool',
			ref: `${REMOTE}:store-front/wrk2`,
			name: 'Edit',
			summary: 'edit src/cart/CartLine.tsx',
		},
		{
			type: 'tool',
			ref: `${REMOTE}:store-front/wrk2`,
			name: 'Bash',
			summary: 'run bun test media',
		},
		{
			type: 'assistant_text',
			ref: `${REMOTE}:store-front/wrk2`,
			text: 'Product cards and cart lines use the helper now; **9 pass**. The order confirmation email is the last place that builds its own image links.',
		},
		{
			type: 'tool',
			ref: `${REMOTE}:store-front/wrk2`,
			name: 'Read',
			summary: 'read src/email/OrderConfirmation.tsx',
		},
		{
			type: 'dev_servers',
			ref: `${REMOTE}:store-front/wrk2`,
			isSettled: true,
			servers: [
				{ name: 'web', port: 4110, url: 'http://localhost:4110', state: 'running', detail: null },
			],
		},
	);

	// What was said to Voice OS, per screen.
	steps.push(
		logVoice(
			HOME_SCREEN,
			'what is everyone doing',
			[],
			180,
			'Store front is building the search box, checkout finished the retry backoff, and signals has a question for you.',
		),
		logVoice(
			'store-front/main',
			'add a search box to the catalog that filters products as you type',
			['send_to store-front/main'],
			420,
		),
		logVoice(
			`${REMOTE}:store-front/wrk2`,
			'serve the product images from the CDN, keep the local ones as a fallback',
			[`send_to ${REMOTE}:store-front/wrk2`],
			600,
		),
	);

	return play(steps);
};

interface Shot {
	// Where it is written under docs/images: voice-os/<name>.png unless set.
	name: string;
	dir?: 'voice-os' | 'setup' | 'home';
	// The page's address; /voice when not set (the view comes from the state).
	path?: string;
	// What crew answers: its goldens (default), or nothing yet (a first run).
	crew?: 'golden' | 'empty';
	viewport?: { width: number; height: number };
	world?: WorldOptions;
	// What happens after the shared world, before the shot.
	stage?: (world: State) => State;
	view?: View;
	// Before the page loads: the listening mode this tab kept.
	listenMode?: 'on-demand' | 'hands-free';
	// Runs in the page before the screenshot.
	prepare?: (page: Page) => Promise<void>;
	// Only the top of the page, this tall: the overviews end well above the fold.
	height?: number;
	// Only these elements, together; tight: cropped to their own width too, not the page's.
	around?: string[];
	tight?: boolean;
	// What to click in this step: Playwright selectors ringed for the shot. The ring is the script's,
	// injected into the page, never the app's.
	highlight?: string[];
	// What this shot's crew answers beyond its goldens (a dev server's log lines).
	crewSetup?: (crew: FakeCrew) => void;
}

const say = (text: string, ref: string, secondsAgo = 4): Step => ({
	input: { type: 'spoken', text, source: 'narrator', ref },
	secondsAgo,
});

const STORE_FRONT_LINE =
	'Store front, main: search works in the tests, fourteen pass. Trying it in the browser now.';

// A blocked call on checkout, allowed once, then a second one waiting on the developer.
const blockCheckout = (world: State): State => {
	const ref = 'checkout-api/main';
	const started = play(
		[
			logVoice(ref, 'ship the retry fix to staging', [`send_to ${ref}`], 240),
			{ input: { type: 'send', ref, text: 'Ship the retry fix to staging' }, secondsAgo: 240 },
			{ input: { type: 'turn_started', ref }, secondsAgo: 238 },
			{ input: { type: 'tool', ref, name: 'Bash', summary: 'run go test ./...' }, secondsAgo: 230 },
			{ input: { type: 'tool_result', ref, ok: true, summary: 'ok' }, secondsAgo: 200 },
			{
				input: {
					type: 'denied',
					ref,
					toolName: 'Bash',
					summary: 'run git push origin crew/checkout-api/main',
				},
				secondsAgo: 190,
			},
		],
		world,
	);
	const pushDenial = started.denials.at(-1);

	if (!pushDenial) {
		throw new Error('the push denial was not recorded');
	}

	return play(
		[
			logVoice(ref, 'allow it', [`allow_denied ${ref}`], 150),
			{ input: { type: 'allow_denied', denialId: pushDenial.id }, secondsAgo: 150 },
			{
				input: {
					type: 'tool',
					ref,
					name: 'Bash',
					summary: 'run git push origin crew/checkout-api/main',
				},
				secondsAgo: 148,
			},
			{
				input: {
					type: 'assistant_text',
					ref,
					text: 'Pushed the branch. The staging deploy is next.',
				},
				secondsAgo: 140,
			},
			{
				input: { type: 'denied', ref, toolName: 'Bash', summary: 'run make deploy-staging' },
				secondsAgo: 20,
			},
		],
		started,
	);
};

// The Active view with an active session whose machine is out of reach.
const activeOffline = (world: State): State =>
	play(
		[
			{
				input: {
					type: 'machines',
					machines: [
						{ id: REMOTE, host: `dev@${REMOTE}`, name: 'Build box' },
						{ id: OFFLINE, host: `dev@${OFFLINE}`, name: 'Lab box' },
					],
				},
				secondsAgo: 30,
			},
			{
				input: {
					type: 'machine_status',
					id: OFFLINE,
					status: 'unreachable',
					detail: `ssh ${OFFLINE} timed out`,
				},
				secondsAgo: 30,
			},
			{
				input: {
					type: 'active_loaded',
					refs: [
						'store-front/main',
						'checkout-api/main',
						'signals/wrk1',
						`${REMOTE}:setup`,
						`${REMOTE}:store-front/wrk2`,
						`${OFFLINE}:admin/wrk3`,
					],
				},
				secondsAgo: 30,
			},
		],
		world,
	);

const OVERVIEW_HEIGHT = 420;

// Two files waiting on store-front/main: chips above the box, sent with the next words.
const attachTwoFiles = (world: State): State =>
	play(
		[
			{
				input: {
					type: 'attachment_added',
					ref: 'store-front/main',
					attachment: {
						id: 'a1b2c3d4e5f60718/checkout-error.log',
						name: 'checkout-error.log',
						kind: 'file',
						bytes: 18_432,
					},
				},
				secondsAgo: 20,
			},
			{
				input: {
					type: 'attachment_added',
					ref: 'store-front/main',
					attachment: {
						id: 'f1e2d3c4b5a69788/search-spec.pdf',
						name: 'search-spec.pdf',
						kind: 'file',
						bytes: 412_000,
					},
				},
				secondsAgo: 12,
			},
		],
		world,
	);

// store-front/main asks to run its migrations: the permission docked above the box.
const askToMigrate = (world: State): State =>
	play(
		[
			{
				input: {
					type: 'ask_opened',
					ask: {
						id: 'p-migrate',
						ref: 'store-front/main',
						at: Date.now() - 30_000,
						kind: 'permission',
						toolName: 'Bash',
						summary: 'run the database migrations',
						input: { command: 'pnpm db:migrate' },
						suggestions: [],
					},
				},
				secondsAgo: 30,
			},
		],
		world,
	);

const WEB_LOG = [
	'$ pnpm dev',
	'VITE v6.2.1  ready in 412 ms',
	'Local:   http://localhost:4100/',
	'[hmr] update /src/catalog/SearchBox.tsx',
	'GET /api/products?q=mug 200 18 ms',
	'GET /api/cart 502 (proxy: connect ECONNREFUSED 127.0.0.1:4101)',
	'[hmr] update /src/catalog/ProductCard.tsx',
	'GET /api/products?q=mug 200 11 ms',
];

const STORE_FRONT_VIEW: View = { kind: 'session', ref: 'store-front/main' };
const withStoreFrontLine = (world: State): State =>
	play([say(STORE_FRONT_LINE, 'store-front/main')], world);

const SHOTS: Shot[] = [
	{ name: 'crew-home', dir: 'home', path: '/' },
	{ name: 'activate', view: { kind: 'activate' } },
	{ name: 'settings', view: { kind: 'settings' } },
	{
		name: 'session',
		view: STORE_FRONT_VIEW,
		stage: withStoreFrontLine,
	},
	{ name: 'active', view: { kind: 'active' }, stage: activeOffline, height: OVERVIEW_HEIGHT },
	{
		name: 'question',
		view: { kind: 'session', ref: 'signals/wrk1' },
		world: { isSignalsAsking: true },
		stage: (world) =>
			play(
				[
					logVoice(
						'signals/wrk1',
						'start recording product clicks so we can rank search results',
						['send_to signals/wrk1'],
						900,
					),
					say(
						'Signals asks: where should the click events be stored? Say options to hear them.',
						'signals/wrk1',
						50,
					),
				],
				world,
			),
	},
	{ name: 'approval', view: { kind: 'session', ref: 'checkout-api/main' }, stage: blockCheckout },
	{
		name: 'listening-modes',
		view: STORE_FRONT_VIEW,
		stage: withStoreFrontLine,
		listenMode: 'on-demand',
		prepare: async (page) => {
			await page.getByRole('button', { name: 'Listening mode' }).click();
			await page.getByRole('menu', { name: 'Listening mode' }).waitFor();
		},
		around: ['.mode-menu', '.vo-spoken', '.vo-bar'],
	},
	{
		name: 'phone',
		view: STORE_FRONT_VIEW,
		viewport: { width: 390, height: 844 },
		stage: withStoreFrontLine,
	},
	{
		name: 'answer',
		view: { kind: 'active' },
		world: { isSignalsAsking: true },
		stage: activeOffline,
		height: OVERVIEW_HEIGHT,
		highlight: ['.vo-row.waiting .vo-answer'],
	},
	{
		name: 'new-menu',
		view: { kind: 'active' },
		stage: activeOffline,
		prepare: async (page) => {
			await page.locator('.vo-new').click();
			await page.getByRole('menu', { name: 'New' }).waitFor();
		},
		around: ['.vo-top', '.nm-menu'],
		tight: true,
	},
	{
		name: 'new-session',
		view: { kind: 'active' },
		prepare: async (page) => {
			await page.locator('section[aria-label="Home"] .vo-head button.primary').click();
			const form = page.getByRole('form', { name: /New session on/ });
			await form.getByRole('textbox', { name: 'Folder' }).fill('~/notes');
			await form.getByRole('textbox', { name: 'Name' }).fill('research');
			// Off the field, so the only ring is the one on Start session.
			await page.locator('.nsd-head h2').click();
		},
		highlight: ['.nsd button[type="submit"]'],
	},
	{
		name: 'machine',
		view: { kind: 'activate', machine: REMOTE },
		highlight: ['.vo-machine-page .vo-head button.primary'],
	},
	{
		name: 'dev-servers',
		view: STORE_FRONT_VIEW,
		stage: withStoreFrontLine,
		around: ['section[aria-label="dev servers"]'],
		tight: true,
		highlight: ['button[aria-label="web logs"]'],
	},
	{
		name: 'dev-logs',
		view: STORE_FRONT_VIEW,
		stage: withStoreFrontLine,
		crewSetup: (crew) => crew.setDevLogs('web', WEB_LOG),
		prepare: async (page) => {
			await page.getByRole('button', { name: 'web logs' }).click();
			await page.getByRole('dialog', { name: 'dev server logs' }).getByText('$ pnpm dev').waitFor();
		},
	},
	{
		name: 'attachments',
		view: STORE_FRONT_VIEW,
		stage: (world) => attachTwoFiles(withStoreFrontLine(world)),
		around: ['.vo-bar'],
		highlight: ['button[aria-label="Attach files"]'],
	},
	{
		name: 'permission',
		view: STORE_FRONT_VIEW,
		stage: (world) => askToMigrate(withStoreFrontLine(world)),
		around: ['.vo-bar'],
	},
	{
		name: 'voice-off',
		view: STORE_FRONT_VIEW,
		stage: (world) =>
			play(
				[{ input: { type: 'set_voice_off', voiceOff: true }, secondsAgo: 5 }],
				withStoreFrontLine(world),
			),
		around: ['.vo-top'],
		highlight: ['.vo-top .vo-voice'],
	},
	{
		name: 'tab-drag',
		view: { kind: 'active' },
		stage: activeOffline,
		prepare: async (page) => {
			const tabs = page.locator('.vo-tab[data-ref]');
			const from = await tabs.nth(3).boundingBox();
			const to = await tabs.nth(1).boundingBox();

			if (!from || !to) {
				throw new Error('tab-drag: the tabs are not there');
			}

			// Held mid-drag over the left half of the second tab: the drop line shows where it lands.
			await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
			await page.mouse.down();
			await page.mouse.move(to.x + 6, to.y + to.height / 2, { steps: 8 });
		},
		around: ['.vo-top'],
	},
	{ name: 'board', dir: 'setup', path: '/setup' },
	{ name: 'workspaces', dir: 'setup', path: '/setup/workspaces' },
	{ name: 'project', dir: 'setup', path: '/setup/project/store-api' },
	{ name: 'project-form', dir: 'setup', path: '/setup/project/store-front/edit' },
	{ name: 'worktree', dir: 'setup', path: '/setup/worktree/store-front/wrk1' },
	{ name: 'new-worktree', dir: 'setup', path: '/setup/workspace/store-front/new-worktree' },
	{ name: 'settings', dir: 'setup', path: '/setup/settings' },
	{ name: 'chat', dir: 'setup', path: '/setup/chat' },
	{ name: 'export', dir: 'setup', path: '/setup/export', height: 820 },
	{ name: 'import', dir: 'setup', path: '/setup/import', height: 420 },
	{
		name: 'logs',
		dir: 'setup',
		path: '/setup/worktree/store-front/wrk1/logs',
		crewSetup: (crew) => crew.setDevLogs('web', WEB_LOG),
		height: 620,
	},
	{ name: 'machines', dir: 'setup', path: '/setup/machine', height: 360 },
	{ name: 'first-run', dir: 'setup', path: '/setup', crew: 'empty' },
	{ name: 'board-phone', dir: 'setup', path: '/setup', viewport: { width: 390, height: 844 } },
	{
		name: 'hero',
		view: { kind: 'session', ref: `${REMOTE}:store-front/wrk2` },
		stage: (world) =>
			play(
				[
					say(
						'Build box, store front: product cards and the cart use the CDN now, nine tests pass. The confirmation email is next.',
						`${REMOTE}:store-front/wrk2`,
					),
				],
				world,
			),
	},
];

type Clip = { x: number; y: number; width: number; height: number };

// A margin around a cropped shot, so a ring at its edge is not cut.
const RING_MARGIN = 12;
const RING_CLASS = 'docs-click-here';

const findClip = async (page: Page, shot: Shot): Promise<Clip | null> => {
	const viewport = shot.viewport ?? VIEWPORT;

	if (shot.height) {
		return { x: 0, y: 0, width: viewport.width, height: shot.height };
	}

	if (!shot.around) {
		return null;
	}

	const boxes = await Promise.all(
		shot.around.map((selector) => page.locator(selector).first().boundingBox()),
	);
	const margin = shot.tight || shot.highlight ? RING_MARGIN : 0;
	const top = Math.max(0, Math.min(...boxes.map((box) => box?.y ?? viewport.height)) - margin);
	const bottom = Math.min(
		viewport.height,
		Math.max(...boxes.map((box) => (box ? box.y + box.height : 0))) + margin,
	);

	if (!shot.tight) {
		return { x: 0, y: top, width: viewport.width, height: bottom - top };
	}

	const left = Math.max(0, Math.min(...boxes.map((box) => box?.x ?? 0)) - margin);
	const right = Math.min(
		viewport.width,
		Math.max(...boxes.map((box) => (box ? box.x + box.width : 0))) + margin,
	);

	return { x: left, y: top, width: right - left, height: bottom - top };
};

// "Click this": a white ring and a soft glow around each element, drawn over the page for the shot.
const ringClickTargets = async (page: Page, selectors: string[]): Promise<void> => {
	await page.addStyleTag({
		content: `.${RING_CLASS} { outline: 2px solid rgba(255, 255, 255, 0.92) !important; outline-offset: 3px !important; box-shadow: 0 0 0 7px rgba(255, 255, 255, 0.14) !important; border-radius: 10px; }`,
	});

	for (const selector of selectors) {
		await page
			.locator(selector)
			.first()
			.evaluate((element, name) => element.classList.add(name), RING_CLASS);
	}
};

const shoot = async (browser: Browser, gateway: Gateway, shot: Shot): Promise<void> => {
	const context = await browser.newContext({
		viewport: shot.viewport ?? VIEWPORT,
		permissions: ['microphone'],
		// The page at rest: no opening, no moment, no page rise.
		reducedMotion: 'reduce',
	});

	// Localhost only: nothing leaves the machine.
	await context.route('**/*', (route) =>
		new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort(),
	);

	if (shot.listenMode) {
		await context.addInitScript((mode) => {
			sessionStorage.setItem('voiceos.listenMode', mode);
		}, shot.listenMode);
	}

	try {
		const page = await context.newPage();
		const errors: string[] = [];

		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(`http://localhost:${gateway.port}/login?token=${TOKEN}`);
		await page.goto(`http://localhost:${gateway.port}${shot.path ?? '/voice'}`);
		await page.waitForSelector('.vo-top, .top, .launcher');
		await shot.prepare?.(page);
		// The stream scrolls to its end, crew's reads land and the mic settles.
		await page.waitForTimeout(1200);

		if (shot.highlight) {
			await ringClickTargets(page, shot.highlight);
		}

		if (errors.length > 0) {
			throw new Error(`${shot.name}: the page threw: ${errors.join('; ')}`);
		}

		const dir = join(IMAGES_DIR, shot.dir ?? 'voice-os');
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${shot.name}.png`);
		const clip = await findClip(page, shot);

		await page.screenshot({ path, ...(clip ? { clip } : {}) });
		console.log(`wrote ${path}`);
	} finally {
		await context.close();
	}
};

// Names given (`bun run docs:screenshots question approval`): only those shots are retaken. A
// misspelt name would otherwise take nothing and still exit clean.
const readOnlyShots = (): string[] => {
	const only = process.argv.slice(2);
	const known = SHOTS.map(({ name }) => name);
	const unknown = only.filter((name) => !known.includes(name));

	if (unknown.length > 0) {
		throw new Error(`unknown shot ${unknown.join(', ')}; shots are: ${known.join(', ')}`);
	}

	return only;
};

const main = async (): Promise<void> => {
	const only = readOnlyShots();
	configureLog({ quiet: true });
	const store = new SnapshotStore();
	// One fake crew per shot, so a first run starts from nothing.
	let crew: FakeCrew = createFakeCrew();
	const runCrew: RunSetupCommand = (machine, command) => crew.runCrew(machine, command);
	const gateway = startGateway({
		store,
		token: TOKEN,
		port: 0,
		index,
		listAllowedOrigins: (port) => listAllowedOrigins({ port, proxyHost: null, proxyPort: null }),
		// The page's clicks and mic go nowhere: each shot is of a fixed state.
		onMessage: () => undefined,
		onAudio: () => undefined,
		readHealth: () => ({}),
		runCrew,
	});
	let browser: Browser | null = null;

	try {
		browser = await chromium.launch({
			args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
		});

		for (const shot of SHOTS.filter(({ name }) => only.length === 0 || only.includes(name))) {
			const world = buildWorld(shot.world);
			const staged = shot.stage ? shot.stage(world) : world;

			crew = createFakeCrew({ seed: shot.crew ?? 'golden', remotes: [REMOTE] });
			shot.crewSetup?.(crew);
			store.snapshot = shot.view
				? play([{ input: { type: 'switch_view', view: shot.view }, secondsAgo: 1 }], staged)
				: staged;
			await shoot(browser, gateway, shot);
		}
	} finally {
		await browser?.close();
		gateway.stop();
	}
};

await main();
