// The screenshots in docs/images/voice-os/, setup/, home/ and tutorials/, rendered from the real page
// and a made-up state: the demo store (store-front and store-api) on this Mac and a build box.
//
// Rerun after a UI change that the docs show (Home, a Voice OS view, a Set up page): `bun run
// docs:screenshots` from voiceos/. The state goes through the real reducer, the page is the real
// bundle behind the real gateway on a random localhost port, crew is the fake the UI tests use
// (crew's own JSON shapes, from voiceos/testdata/, with the store seeded over them), and Chromium is Playwright's. Nothing reads or
// writes ~/.crew, no session, key or API is involved, and nothing leaves the machine: the page uses
// the system font.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { RunSetupCommand } from '../src/crew/api.js';
import index from '../src/web/index.html';
import { listAllowedOrigins } from '../src/gateway/auth.js';
import { startGateway, type Gateway } from '../src/gateway/server.js';
import { configureLog } from '../src/log.js';
import { LOCAL_MACHINE } from '../src/shared/machine-ref.js';
import {
	HOME_SCREEN,
	type Input,
	type PendingAsk,
	type State,
	type View,
} from '../src/shared/protocol.js';
import { createInitialState, reduce } from '../src/state/reducer.js';
import { Store } from '../src/state/store.js';
import type { CrewProject } from '../src/web/setup/types.js';
import { createFakeCrew, type FakeCrew } from '../test/support/fake-crew.js';

const IMAGES_DIR = join(import.meta.dir, '..', '..', 'docs', 'images');
const TOKEN = 'd'.repeat(64);
const VIEWPORT = { width: 1440, height: 900 };
// A page that opens this narrow is a phone: Voice OS's phone layout, shot at the phone's own density.
const PHONE = { width: 390, height: 844 };
const PHONE_AGENTS = {
	iphone:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
	android:
		'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
} as const;
// This Mac's worktrees, and the build box's: a tile shows its machine's own kind of path.
const LOCAL_HOME = '/Users/dev';
const REMOTE_HOME = '/home/dev';
const REMOTE = 'store-vm';
const OFFLINE = 'lab-vm';
const MODEL = 'claude-opus-5-5[1m]';

// The demo store a video shows: a React storefront and the FastAPI service behind it, one workspace
// with two worktrees on this Mac and one on the build box.
const STORE_FRONT_REMOTE = 'git@github.com:FurlanLuka/store-front.git';
const STORE_API_REMOTE = 'git@github.com:FurlanLuka/store-api.git';
// What crew detects from each repo's lockfiles: its runner's install steps.
const DETECTED_STEPS: Record<string, string[]> = {
	'store-front': ['mise install', 'npm ci'],
	'store-api': ['mise install', 'uv sync'],
};
// The ports crew gave each worktree's servers: web, api (the worker listens on none).
const PORTS: Record<string, { web: number; api: number }> = {
	'store/main': { web: 54010, api: 54012 },
	'store/wrk1': { web: 54030, api: 54032 },
};
const LOCAL_WORKTREES = ['main', 'wrk1'];

const demoProjects = (home: string): CrewProject[] => [
	{
		name: 'store-front',
		path: `${home}/.crew/projects/store-front`,
		dev_servers: [{ name: 'web', port: 5173, command: 'npm run dev' }],
		bindings: [{ var: 'VITE_API_URL', value: '{{store-api/api}}' }],
		remote: STORE_FRONT_REMOTE,
	},
	{
		name: 'store-api',
		path: `${home}/.crew/projects/store-api`,
		dev_servers: [
			{
				name: 'api',
				port: 8000,
				command: 'uv run uvicorn app.main:app --reload --port $PORT',
			},
			{ name: 'worker', command: 'uv run python -m app.worker' },
		],
		bindings: [{ var: 'CORS_ORIGIN', value: '{{store-front}}' }],
		env_cmd: 'scripts/get-env.sh',
		remote: STORE_API_REMOTE,
	},
];

// A template over the store's two projects, expanded the way crew does for one worktree.
const expand = (template: string, ref: string): string | null => {
	const ports = PORTS[ref];

	if (!ports) {
		return null;
	}

	const portOf = (target: string): number | null =>
		target === 'store-front' || target === 'store-front/web'
			? ports.web
			: target === 'store-api' || target === 'store-api/api'
				? ports.api
				: null;
	let isResolved = true;
	const value = template.replace(/\{\{\s*([^}\s]+?)(\.host|\.port)?\s*\}\}/g, (_, target, part) => {
		const port = portOf(target);

		if (port === null) {
			isResolved = false;

			return '';
		}

		return part === '.port'
			? String(port)
			: part === '.host'
				? `localhost:${port}`
				: `http://localhost:${port}`;
	});

	return isResolved ? value : null;
};

const BINDING_OF: Record<string, { var: string; value: string }> = {
	'store-front': { var: 'VITE_API_URL', value: '{{store-api/api}}' },
	'store-api': { var: 'CORS_ORIGIN', value: '{{store-front}}' },
};

const previewsFor = (value: string) =>
	Object.keys(PORTS).map((ref) => ({
		ref,
		value: expand(value, ref) ?? '',
		resolved: expand(value, ref) !== null,
		running: ref === 'store/main',
	}));

const SETUP_LOG: Record<string, string[]> = {
	'store-front': [
		'▸ checkout',
		'✓ checkout 0.8s',
		'▸ mise install',
		'node 24.21.0 already installed',
		'✓ mise install 0.4s',
		'▸ npm ci',
		'added 312 packages, and audited 313 packages in 9s',
		'✓ npm ci 9.2s',
		'▸ smoke web',
		'✓ smoke web 1.6s',
	],
	'store-api': [
		'▸ checkout',
		'✓ checkout 0.7s',
		'▸ mise install',
		'python 3.13.5 already installed',
		'✓ mise install 0.3s',
		'▸ uv sync',
		'Installed 41 packages in 212ms',
		'✓ uv sync 3.1s',
		'▸ env: scripts/get-env.sh',
		'wrote .env (7 values)',
		'✓ env: scripts/get-env.sh 1.2s',
		'▸ smoke api',
		'✓ smoke api 2.4s',
		'▸ smoke worker',
		'✓ smoke worker 4.0s',
	],
};

// Every shot but a first run: crew holds the store, on this Mac and on the build box.
const demoCrew = (crew: FakeCrew): void => {
	for (const [id, machine] of Object.entries(crew.machines)) {
		const isLocal = id === LOCAL_MACHINE;
		const home = isLocal ? LOCAL_HOME : REMOTE_HOME;
		const names = isLocal ? LOCAL_WORKTREES : ['main'];

		machine.projects = demoProjects(home);
		machine.workspaces = [
			{
				name: 'store',
				projects: [
					{ name: 'store-front', mode: 'worktree' },
					{ name: 'store-api', mode: 'worktree' },
				],
				worktrees: [...names],
			},
		];
		machine.worktrees = names.map((name) => ({
			ref: `store/${name}`,
			devRunning: name === 'main',
			sizeBytes: name === 'main' ? 1_503_238_553 : 912_261_120,
			overrides: {},
			issues: [],
			run: null,
		}));
		machine.checks = {};
		machine.scan = [
			{
				name: 'store-front',
				path: `${home}/code/store-front`,
				remote: STORE_FRONT_REMOTE,
				known: true,
			},
			{ name: 'store-api', path: `${home}/code/store-api`, remote: STORE_API_REMOTE, known: true },
		];
		machine.cleanDryRun = [
			{ kind: 'setup', path: `${home}/.crew/setup/store--wrk2`, removed: false },
			{ kind: 'logs', path: `${home}/.crew/logs/store--wrk2`, removed: false },
			{ kind: 'trash', path: `${home}/.crew/trash`, removed: false },
		];
		machine.voiceMachines = isLocal
			? [{ id: REMOTE, host: `dev@${REMOTE}`, name: 'Build box', status: 'connected' }]
			: [];
		machine.chats = isLocal ? machine.chats : [];
		machine.installSteps = DETECTED_STEPS;
		machine.worktreesDir = `${home}/.crew/workspaces`;
	}

	const servers = (ref: string) => {
		const ports = PORTS[ref] ?? { web: 0, api: 0 };

		return [
			{
				worktree: ref,
				project: 'store-front',
				server_name: 'web',
				external_port: 5173,
				url: `http://localhost:${ports.web}`,
			},
			{
				worktree: ref,
				project: 'store-api',
				server_name: 'api',
				external_port: 8000,
				url: `http://localhost:${ports.api}`,
			},
			{ worktree: ref, project: 'store-api', server_name: 'worker', external_port: 0, url: '' },
		];
	};

	crew.setAnswer('dev_status', (command: { ref?: string }) =>
		servers('store/main').filter((row) => !command.ref || row.worktree === command.ref),
	);
	crew.setAnswer('dev_check', (command: { ref: string }) => {
		const ports = PORTS[command.ref] ?? { web: 0, api: 0 };

		return [
			{
				project: 'store-front',
				server: 'web',
				port: ports.web,
				alive: true,
				listening: true,
				referenced: true,
				took_ms: 1600,
			},
			{
				project: 'store-api',
				server: 'api',
				port: ports.api,
				alive: true,
				listening: true,
				referenced: true,
				took_ms: 2400,
			},
			{
				project: 'store-api',
				server: 'worker',
				port: 0,
				alive: true,
				listening: false,
				referenced: false,
				took_ms: 4000,
			},
		];
	});
	crew.setAnswer('env', (command: { ref: string; project: string }) => {
		const binding = BINDING_OF[command.project];
		const overrides =
			crew.machines[LOCAL_MACHINE]?.worktrees.find((row) => row.ref === command.ref)?.overrides ??
			{};

		if (!binding) {
			return [];
		}

		// A value set for this worktree wins over the project's binding, as crew resolves it.
		const pinned = overrides[`${command.project}.${binding.var}`] ?? overrides[binding.var];

		return [
			pinned === undefined
				? {
						var: binding.var,
						server: '',
						value: expand(binding.value, command.ref) ?? '',
						source: 'binding',
						detail: binding.value,
					}
				: {
						var: binding.var,
						server: '',
						value: pinned,
						source: 'override',
						detail: 'worktree override',
					},
		];
	});
	crew.setAnswer('ls_bindings', (command: { project: string }) => {
		const binding = BINDING_OF[command.project];

		return binding
			? [{ ...binding, server: '', result: expand(binding.value, 'store/main') ?? '' }]
			: [];
	});
	crew.setAnswer('ls_bindings_preview', (command: { project: string }) => {
		const binding = BINDING_OF[command.project];

		return binding ? [{ ...binding, server: '', previews: previewsFor(binding.value) }] : [];
	});
	crew.setAnswer('add_binding_scan', (command: { project: string }) =>
		command.project === 'store-front'
			? [
					{
						var: 'VITE_API_URL',
						value: 'http://localhost:8000',
						port: 8000,
						template: '{{store-api/api}}',
						status: 'already bound',
					},
				]
			: [
					{
						var: 'CORS_ORIGIN',
						value: 'http://localhost:5173',
						port: 5173,
						template: '{{store-front}}',
						status: 'already bound',
					},
				],
	);
	crew.setAnswer(
		'add_binding_dry_run',
		(command: { var: string; value: string; server?: string }) => ({
			var: command.var,
			server: command.server ?? '',
			value: command.value,
			previews: previewsFor(command.value),
		}),
	);
	crew.setAnswer('setup_logs', (command: { ref: string; project: string; server?: string }) => ({
		ref: command.ref,
		project: command.project,
		...(command.server ? { server: command.server } : {}),
		lines: command.server
			? [`${command.server} started by the runner`, `${command.server} listening`]
			: (SETUP_LOG[command.project] ?? []),
	}));
	crew.setAnswer('rm_worktree_dry_run', {
		checkouts: ['store-front', 'store-api'].map((project, index) => ({
			ref: 'store/wrk1',
			project,
			path: `${LOCAL_HOME}/.crew/workspaces/store/wrk1/${project}`,
			direct: false,
			missing: false,
			uncommitted: index === 0 ? 3 : 0,
			commits: index === 0 ? 2 : 1,
			size_bytes: index === 0 ? 524_288_000 : 209_715_200,
		})),
		last: false,
	});
	crew.setAnswer('rm_workspace_project_dry_run', {
		checkouts: LOCAL_WORKTREES.map((name, index) => ({
			ref: `store/${name}`,
			project: 'store-api',
			path: `${LOCAL_HOME}/.crew/workspaces/store/${name}/store-api`,
			direct: false,
			missing: false,
			uncommitted: index === 0 ? 1 : 0,
			commits: 0,
			size_bytes: 209_715_200,
		})),
		last: false,
	});
	// Every machine runs the current crew: the main keeps its remotes on its own release.
	crew.setAnswer('update_check', {
		current: '6.10.0',
		latest: '6.10.0',
		available: false,
		dev: false,
		line: 'crew v6.10.0 — up to date',
	});
	// This Mac's own addresses: no proxy domain set, so the proxy follows its IP (nip.io).
	crew.setAnswer('config_show', {
		server_ip: '192.168.1.20',
		ssh_host: 'dev-mac',
		proxy_port: 80,
		proxy_https_port: 0,
		domain: '',
	});
	crew.setAnswer('discord_status', {
		set_up: true,
		token: true,
		config: {
			guild: '155',
			channel: '226',
			channel_name: 'Voice OS',
			guild_name: 'Store team',
			owner: '99',
			text_channel: '1001',
			text_channel_name: 'general',
		},
		live: { connected: true, owner_in_channel: true, error: '', at: new Date().toISOString() },
	});
};

// A first run: nothing in crew and no checkout in the usual folders, so the store comes in by URL.
const demoFirstRun = (crew: FakeCrew): void => {
	const machine = crew.machines[LOCAL_MACHINE];

	if (machine) {
		machine.scan = [];
		machine.installSteps = DETECTED_STEPS;
		machine.worktreesDir = `${LOCAL_HOME}/.crew/workspaces`;
	}
};

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
		cwd: isSetup ? home : `${home}/.crew/workspaces/${local}`,
		dirs: [],
		isPinned: isSetup,
	};
};

const MAIN = 'store/main';
const WRK1 = 'store/wrk1';
const REMOTE_MAIN = `${REMOTE}:store/main`;
const REMOTE_SETUP = `${REMOTE}:setup`;

const QUEUE_QUESTION: PendingAsk = {
	id: 'ask-queue',
	ref: WRK1,
	at: Date.now() - 60_000,
	kind: 'question',
	input: {},
	questions: [
		{
			question: 'Where should the worker pick up the order emails from?',
			multiSelect: false,
			options: [
				{
					label: 'A Redis queue',
					description: 'The worker blocks on a list; needs Redis in every worktree',
				},
				{
					label: 'A jobs table in Postgres',
					description: 'No new service; the worker polls it every second',
				},
				{
					label: 'Send them inline for now',
					description: 'From the order request; move them to the worker later',
				},
			],
		},
	],
};

interface WorldOptions {
	// store/wrk1 asks through the ask dock mid-turn, instead of in words at the end of it.
	isWrk1Asking?: boolean;
	// store/wrk1 finished its emails instead of asking about them.
	isWrk1Done?: boolean;
}

const devServers = (ref: string, web: number, api: number): Input => ({
	type: 'dev_servers',
	ref,
	isSettled: true,
	servers: [
		{ name: 'web', port: web, url: `http://localhost:${web}`, state: 'running', detail: null },
		{ name: 'api', port: api, url: `http://localhost:${api}`, state: 'running', detail: null },
		{ name: 'worker', port: 0, url: null, state: 'running', detail: null },
	],
});

// The store on this Mac (main and wrk1), the build box's main, and each machine's setup session.
const buildWorld = ({ isWrk1Asking = false, isWrk1Done = false }: WorldOptions = {}): State => {
	const { steps, at } = timeline();

	at(
		3600,
		{ type: 'machines', machines: [{ id: REMOTE, host: `dev@${REMOTE}`, name: 'Build box' }] },
		{
			type: 'worktrees',
			worktrees: [
				worktree('setup', 'setup', true),
				worktree(MAIN),
				worktree(WRK1),
				worktree(REMOTE_SETUP, 'setup', true),
				worktree(REMOTE_MAIN, 'store/main'),
			],
		},
		{ type: 'machine_resynced', id: REMOTE, inputs: [] },
		{ type: 'limits', limits: { sevenDay: 34, fiveHour: 12, resetsAt: null } },
		{ type: 'active_loaded', refs: [MAIN, WRK1, REMOTE_SETUP, REMOTE_MAIN] },
	);

	for (const ref of ['setup', MAIN, WRK1, REMOTE_SETUP, REMOTE_MAIN]) {
		at(3500, { type: 'session_started', ref }, { type: 'session_model', ref, model: MODEL });
	}

	// How full each session's context is: the composer's meter.
	for (const [ref, used] of [
		['setup', 61_000],
		[MAIN, 412_000],
		[WRK1, 188_000],
		[REMOTE_SETUP, 74_000],
		[REMOTE_MAIN, 296_000],
	] as const) {
		at(3450, { type: 'context_usage', ref, used, max: 1_000_000 });
	}

	// What earlier turns cost, so a running session's cost is not $0.00.
	for (const [ref, costUsd] of [
		[MAIN, 0.64],
		[WRK1, 0.12],
		[REMOTE_MAIN, 0.51],
	] as const) {
		at(3400, { type: 'turn_ended', ref, costUsd, text: '' });
	}

	// setup: registered the two repos and made the store workspace, then went quiet.
	at(
		3000,
		{
			type: 'send',
			ref: 'setup',
			text: 'Add store-front and store-api to crew and put them in one workspace',
		},
		{ type: 'turn_started', ref: 'setup' },
		{
			type: 'tool',
			ref: 'setup',
			name: 'Bash',
			summary: `run crew add project store-front ${STORE_FRONT_REMOTE}`,
		},
		{ type: 'tool_result', ref: 'setup', ok: true, summary: 'Added project store-front' },
		{
			type: 'tool',
			ref: 'setup',
			name: 'Bash',
			summary: `run crew add project store-api ${STORE_API_REMOTE}`,
		},
		{ type: 'tool_result', ref: 'setup', ok: true, summary: 'Added project store-api' },
		{ type: 'tool', ref: 'setup', name: 'Read', summary: 'read store-front/package.json' },
		{
			type: 'tool',
			ref: 'setup',
			name: 'Bash',
			summary: 'run crew dev add store-front --name=web --cmd="npm run dev" --port=5173',
		},
		{ type: 'tool_result', ref: 'setup', ok: true, summary: "Added dev server 'web'" },
		{
			type: 'tool',
			ref: 'setup',
			name: 'Bash',
			summary: "run crew add binding store-front VITE_API_URL '{{store-api/api}}'",
		},
		{
			type: 'tool',
			ref: 'setup',
			name: 'Bash',
			summary: 'run crew add workspace store store-front store-api',
		},
		{ type: 'tool_result', ref: 'setup', ok: true, summary: 'Created workspace store' },
		{
			type: 'assistant_text',
			ref: 'setup',
			text: 'Added **store-front** and **store-api** and wired them both ways. `store/main` is set up: web answers on :54010, api on :54012, and the worker runs beside it.',
		},
		{ type: 'turn_ended', ref: 'setup', costUsd: 0.18, text: '' },
	);

	// store/main: building the search box, mid-turn.
	at(
		420,
		{
			type: 'send',
			ref: MAIN,
			text: 'Add a search box to the catalog that filters products as you type',
			isSpoken: true,
		},
		{ type: 'turn_started', ref: MAIN },
		{
			type: 'assistant_text',
			ref: MAIN,
			text: "I'll put the search box in the catalog header and filter on the client first: the product list is already loaded there.",
		},
		{
			type: 'tool',
			ref: MAIN,
			name: 'Read',
			summary: 'read store-front/src/catalog/CatalogPage.tsx',
		},
		{ type: 'tool', ref: MAIN, name: 'Grep', summary: 'search for useProducts' },
		{
			type: 'tool',
			ref: MAIN,
			name: 'Edit',
			summary: 'edit store-front/src/catalog/CatalogPage.tsx',
		},
		{
			type: 'diff',
			ref: MAIN,
			filePath: 'store-front/src/catalog/CatalogPage.tsx',
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
			ref: MAIN,
			name: 'Write',
			summary: 'write store-front/src/catalog/filter-products.ts',
		},
		{ type: 'tool', ref: MAIN, name: 'Bash', summary: 'run npm test -- catalog' },
		{ type: 'tool_result', ref: MAIN, ok: true, summary: '14 pass' },
		{
			type: 'assistant_text',
			ref: MAIN,
			text: 'Search works in the tests: **14 pass**, including matches by category and a query with no results.',
		},
		devServers(MAIN, 54010, 54012),
	);
	at(
		40,
		{
			type: 'tool',
			ref: MAIN,
			name: 'Bash',
			summary: 'run npx playwright screenshot localhost:54010/catalog?q=mug',
		},
		{
			type: 'text_delta',
			ref: MAIN,
			text: 'Trying it in the browser: typing “mug” leaves the two mugs and the',
		},
	);

	// store/wrk1: the worker sends the order confirmation emails.
	at(
		900,
		{
			type: 'send',
			ref: WRK1,
			text: 'Send the order confirmation emails from the worker instead of the request',
		},
		{ type: 'turn_started', ref: WRK1 },
		{ type: 'tool', ref: WRK1, name: 'Read', summary: 'read store-api/app/orders/routes.py' },
		{ type: 'tool', ref: WRK1, name: 'Grep', summary: 'search for send_email' },
		{ type: 'tool', ref: WRK1, name: 'Edit', summary: 'edit store-api/app/worker.py' },
	);

	if (isWrk1Done) {
		at(
			700,
			{ type: 'tool', ref: WRK1, name: 'Bash', summary: 'run uv run pytest tests/orders' },
			{ type: 'tool_result', ref: WRK1, ok: true, summary: '23 passed' },
			{
				type: 'assistant_text',
				ref: WRK1,
				text: 'The order request now queues the email and the worker sends it, with three retries. **23 pass**.',
			},
			{ type: 'turn_ended', ref: WRK1, costUsd: 0.21, text: '' },
		);
	} else if (isWrk1Asking) {
		at(
			60,
			{
				type: 'assistant_text',
				ref: WRK1,
				text: 'The worker has a send_order_email job now. One decision before I take it out of the request:',
			},
			{ type: 'ask_opened', ask: QUEUE_QUESTION },
		);
	} else {
		at(
			900,
			{
				type: 'assistant_text',
				ref: WRK1,
				text: 'The worker has a send_order_email job now. Before I take it out of the request: should the worker pick the emails up from a **Redis queue**, or poll a **jobs table** in Postgres?',
			},
			{ type: 'turn_ended', ref: WRK1, costUsd: 0.21, text: '' },
			{
				type: 'narration',
				ref: WRK1,
				needsUser: true,
				text: 'asks: a Redis queue for the order emails, or a jobs table?',
			},
		);
	}

	at(800, devServers(WRK1, 54030, 54032));

	// The build box's set up: the store cloned there and started.
	at(
		2400,
		{ type: 'send', ref: REMOTE_SETUP, text: 'Set up the store on this box and start main' },
		{ type: 'turn_started', ref: REMOTE_SETUP },
		{
			type: 'tool',
			ref: REMOTE_SETUP,
			name: 'Bash',
			summary: `run crew add project store-front ${STORE_FRONT_REMOTE}`,
		},
		{ type: 'tool_result', ref: REMOTE_SETUP, ok: true, summary: 'Added project store-front' },
		{
			type: 'tool',
			ref: REMOTE_SETUP,
			name: 'Bash',
			summary: `run crew add project store-api ${STORE_API_REMOTE}`,
		},
		{ type: 'tool_result', ref: REMOTE_SETUP, ok: true, summary: 'Added project store-api' },
		{
			type: 'tool',
			ref: REMOTE_SETUP,
			name: 'Bash',
			summary: 'run crew add workspace store store-front store-api --wait',
		},
		{ type: 'tool_result', ref: REMOTE_SETUP, ok: true, summary: 'store/main ready' },
		{ type: 'tool', ref: REMOTE_SETUP, name: 'Bash', summary: 'run crew dev start store/main' },
		{ type: 'tool_result', ref: REMOTE_SETUP, ok: true, summary: 'Started store/main' },
		{
			type: 'assistant_text',
			ref: REMOTE_SETUP,
			text: 'The store runs on Build box now: `store/main` has web on :54010, api on :54012 and the worker beside them. `scripts/get-env.sh` wrote its .env.',
		},
		{ type: 'turn_ended', ref: REMOTE_SETUP, costUsd: 0.14, text: '' },
	);

	// Build box: its store/main is moving the product images to the CDN.
	at(
		600,
		{
			type: 'send',
			ref: REMOTE_MAIN,
			text: 'Serve the product images from the CDN and keep local ones as the fallback',
		},
		{ type: 'turn_started', ref: REMOTE_MAIN },
		{
			type: 'assistant_text',
			ref: REMOTE_MAIN,
			text: 'The images are loaded in three places. I will route them through one `imageUrl()` helper so the CDN switch is a single change.',
		},
		{ type: 'tool', ref: REMOTE_MAIN, name: 'Grep', summary: 'search for /images/products' },
		{
			type: 'tool',
			ref: REMOTE_MAIN,
			name: 'Write',
			summary: 'write store-front/src/media/image-url.ts',
		},
		{
			type: 'tool',
			ref: REMOTE_MAIN,
			name: 'Edit',
			summary: 'edit store-front/src/catalog/ProductCard.tsx',
		},
		{
			type: 'tool',
			ref: REMOTE_MAIN,
			name: 'Edit',
			summary: 'edit store-front/src/cart/CartLine.tsx',
		},
		{ type: 'tool', ref: REMOTE_MAIN, name: 'Bash', summary: 'run npm test -- media' },
		{
			type: 'assistant_text',
			ref: REMOTE_MAIN,
			text: 'Product cards and cart lines use the helper now; **9 pass**. The order confirmation email is the last place that builds its own image links.',
		},
		{
			type: 'tool',
			ref: REMOTE_MAIN,
			name: 'Read',
			summary: 'read store-api/app/emails/order_confirmation.html',
		},
		devServers(REMOTE_MAIN, 54010, 54012),
	);

	// What was said to Voice OS, per screen.
	steps.push(
		logVoice(
			HOME_SCREEN,
			'what is everyone doing',
			[],
			180,
			'Store main is building the search box, wrk1 has a question about the order emails, and the build box is moving the product images to the CDN.',
		),
		logVoice(
			MAIN,
			'add a search box to the catalog that filters products as you type',
			[`send_to ${MAIN}`],
			420,
		),
		logVoice(
			REMOTE_MAIN,
			'serve the product images from the CDN, keep the local ones as a fallback',
			[`send_to ${REMOTE_MAIN}`],
			600,
		),
	);

	return play(steps);
};

type ShotDir = 'voice-os' | 'setup' | 'home' | 'tutorials';

interface Shot {
	// Where it is written under docs/images: voice-os/<name>.png unless set.
	name: string;
	dir?: ShotDir;
	// The page's address; /voice when not set (the view comes from the state).
	path?: string;
	// What crew answers: the demo store (default), or nothing yet (a first run).
	crew?: 'demo' | 'empty';
	// How long a setup runner takes in this shot's crew.
	runMs?: number;
	viewport?: { width: number; height: number };
	world?: WorldOptions;
	// What happens after the shared world, before the shot.
	stage?: (world: State) => State;
	view?: View;
	// Opened from a phone's link, not yet on the home screen: the install guide, as this phone sees it.
	phoneLink?: 'iphone' | 'android';
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
	// What this shot's crew answers beyond the demo (a dev server's log lines).
	crewSetup?: (crew: FakeCrew) => void;
}

const say = (text: string, ref: string, secondsAgo = 4): Step => ({
	input: { type: 'spoken', text, source: 'narrator', ref },
	secondsAgo,
});

const MAIN_LINE =
	'Store main: search works in the tests, fourteen pass. Trying it in the browser now.';

// A blocked call on wrk1, allowed once, then a second one waiting on the developer.
const blockWrk1 = (world: State): State => {
	const ref = WRK1;
	const push = 'run git push origin crew/store/wrk1/store-api';
	const started = play(
		[
			logVoice(ref, 'ship the email worker to staging', [`send_to ${ref}`], 240),
			{ input: { type: 'send', ref, text: 'Ship the email worker to staging' }, secondsAgo: 240 },
			{ input: { type: 'turn_started', ref }, secondsAgo: 238 },
			{ input: { type: 'tool', ref, name: 'Bash', summary: 'run uv run pytest' }, secondsAgo: 230 },
			{ input: { type: 'tool_result', ref, ok: true, summary: '118 passed' }, secondsAgo: 200 },
			{ input: { type: 'denied', ref, toolName: 'Bash', summary: push }, secondsAgo: 190 },
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
			{ input: { type: 'tool', ref, name: 'Bash', summary: push }, secondsAgo: 148 },
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
					refs: [MAIN, WRK1, REMOTE_SETUP, REMOTE_MAIN, `${OFFLINE}:store/wrk2`],
				},
				secondsAgo: 30,
			},
		],
		world,
	);

// Two groups in the top bar: the store on this Mac, and the build box's.
const twoGroups = (world: State): State =>
	play(
		[
			{
				input: {
					type: 'groups_loaded',
					groups: [
						{ id: 'g1', name: 'Store', color: 'blue', refs: [MAIN, WRK1] },
						{ id: 'g2', name: 'Build box', color: 'teal', refs: [REMOTE_SETUP, REMOTE_MAIN] },
					],
					openGroup: null,
				},
				secondsAgo: 30,
			},
		],
		world,
	);

// store/main asks store/wrk1 how the order email is built, and the copy of wrk1 answers.
const askWrk1 = (world: State): State =>
	play(
		[
			{
				input: {
					type: 'session_ask_requested',
					ref: MAIN,
					id: 'peer-1',
					kind: 'ask',
					session: WRK1,
					text: 'Which image URLs does the order confirmation email use, and where are they built?',
					files: [],
				},
				secondsAgo: 30,
			},
			{
				input: {
					type: 'session_fork_settled',
					ref: WRK1,
					id: 'peer-1',
					status: 'answered',
					answer:
						'The email builds its own links in `store-api/app/emails/render.py`: `f"{STOREFRONT_URL}/images/products/{sku}.jpg"`. Nothing else in the API makes image URLs.',
					files: [],
					read: ['store-api/app/emails/render.py', 'store-api/app/emails/order_confirmation.html'],
				},
				secondsAgo: 18,
			},
			{
				input: {
					type: 'assistant_text',
					ref: MAIN,
					text: 'wrk1 builds the email image links in one place, so the CDN helper can replace that one line.',
				},
				secondsAgo: 10,
			},
		],
		world,
	);

const OVERVIEW_HEIGHT = 420;

// Two files waiting on store/main: chips above the box, sent with the next words.
const attachTwoFiles = (world: State): State =>
	play(
		[
			{
				input: {
					type: 'attachment_added',
					ref: MAIN,
					attachment: {
						id: 'a1b2c3d4e5f60718/cors-error.log',
						name: 'cors-error.log',
						kind: 'file',
						bytes: 18_432,
					},
				},
				secondsAgo: 20,
			},
			{
				input: {
					type: 'attachment_added',
					ref: MAIN,
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

// store/main asks to run its migrations: the permission docked above the box.
const askToMigrate = (world: State): State =>
	play(
		[
			{
				input: {
					type: 'ask_opened',
					ask: {
						id: 'p-migrate',
						ref: MAIN,
						at: Date.now() - 30_000,
						kind: 'permission',
						toolName: 'Bash',
						summary: 'run the database migrations',
						input: { command: 'uv run alembic upgrade head' },
						suggestions: [],
					},
				},
				secondsAgo: 30,
			},
		],
		world,
	);

const WEB_LOG = [
	'$ npm run dev',
	'> store-front@0.4.0 dev',
	'> vite',
	'VITE v6.2.1  ready in 412 ms',
	'➜  Local:   http://localhost:54010/',
	'[vite] hmr update /src/catalog/SearchBox.tsx',
	'[vite] hmr update /src/catalog/CatalogPage.tsx',
	'[vite] hmr update /src/catalog/ProductCard.tsx',
];

const API_LOG = [
	'$ uv run uvicorn app.main:app --reload --port 54012',
	"INFO:     Will watch for changes in these directories: ['/Users/dev/.crew/workspaces/store/main/store-api']",
	'INFO:     Uvicorn running on http://127.0.0.1:54012 (Press CTRL+C to quit)',
	'INFO:     Started reloader process [48211] using WatchFiles',
	'INFO:     Application startup complete.',
	'INFO:     127.0.0.1:61022 - "GET /products?q=mug HTTP/1.1" 200 OK',
	'INFO:     127.0.0.1:61022 - "OPTIONS /cart HTTP/1.1" 200 OK',
	'INFO:     127.0.0.1:61024 - "GET /cart HTTP/1.1" 200 OK',
	'INFO:     127.0.0.1:61024 - "POST /orders HTTP/1.1" 201 Created',
];

const MAIN_VIEW: View = { kind: 'session', ref: MAIN };
const withMainLine = (world: State): State => play([say(MAIN_LINE, MAIN)], world);

const FIRST_RUN = 'main[aria-label="First run"]';

const startStepByStep = async (page: Page): Promise<void> => {
	await page
		.locator(FIRST_RUN)
		.getByRole('button', { name: /Set it up step by step/ })
		.click({ timeout: 5000 });
};

// The first run up to the workspace step: both repos added by their URL.
const addStoreByUrl = async (page: Page): Promise<void> => {
	const flow = page.locator(FIRST_RUN);

	await startStepByStep(page);

	for (const [name, url] of [
		['store-front', STORE_FRONT_REMOTE],
		['store-api', STORE_API_REMOTE],
	] as const) {
		await flow.getByRole('button', { name: 'Add by URL' }).click();
		await flow.getByRole('textbox', { name: 'Git URL' }).fill(url);
		await flow.getByRole('button', { name: `Add ${name}` }).click();
		await flow.locator(`[data-row="${name}"]`).waitFor({ timeout: 5000 });
	}
};

const toWorkspaceStep = async (page: Page): Promise<void> => {
	const flow = page.locator(FIRST_RUN);

	await addStoreByUrl(page);
	await flow.getByRole('button', { name: 'Continue' }).click();
	await flow.getByRole('heading', { name: 'Make a workspace' }).waitFor({ timeout: 5000 });
	await flow.getByRole('textbox', { name: 'Name' }).fill('store');
};

const createStore = async (page: Page): Promise<void> => {
	const flow = page.locator(FIRST_RUN);

	await toWorkspaceStep(page);
	await flow.getByRole('button', { name: 'Create store' }).click();
	await flow.getByRole('heading', { name: 'Getting store/main ready' }).waitFor({ timeout: 5000 });
};

const TUTORIAL_FIRST_RUN = {
	dir: 'tutorials',
	path: '/',
	crew: 'empty',
	crewSetup: demoFirstRun,
} as const;

const SHOTS: Shot[] = [
	{ name: 'crew-home', dir: 'home', path: '/' },
	{ name: 'activate', view: { kind: 'activate' } },
	{ name: 'settings', view: { kind: 'settings' } },
	{ name: 'session', view: MAIN_VIEW, stage: withMainLine },
	{ name: 'active', view: { kind: 'active' }, stage: activeOffline, height: OVERVIEW_HEIGHT },
	{
		name: 'question',
		view: { kind: 'session', ref: WRK1 },
		world: { isWrk1Asking: true },
		stage: (world) =>
			play(
				[
					logVoice(
						WRK1,
						'send the order confirmation emails from the worker instead of the request',
						[`send_to ${WRK1}`],
						900,
					),
					say(
						'Store wrk1 asks: where should the worker pick up the order emails from? Say options to hear them.',
						WRK1,
						50,
					),
				],
				world,
			),
	},
	{
		name: 'approval',
		view: { kind: 'session', ref: WRK1 },
		world: { isWrk1Done: true },
		stage: blockWrk1,
	},
	{
		name: 'listening-modes',
		view: MAIN_VIEW,
		stage: withMainLine,
		listenMode: 'on-demand',
		prepare: async (page) => {
			await page.getByRole('button', { name: 'Listening mode' }).click();
			await page.getByRole('menu', { name: 'Listening mode' }).waitFor();
		},
		around: ['.mode-menu', '.vo-spoken', '.vo-bar'],
	},
	{
		name: 'phone',
		view: MAIN_VIEW,
		viewport: PHONE,
		stage: withMainLine,
	},
	{ name: 'phone-home', view: { kind: 'active' }, viewport: PHONE, world: { isWrk1Asking: true } },
	{ name: 'phone-session', view: MAIN_VIEW, viewport: PHONE, stage: withMainLine },
	{
		name: 'phone-question',
		view: { kind: 'session', ref: WRK1 },
		viewport: PHONE,
		world: { isWrk1Asking: true },
	},
	{
		name: 'phone-more',
		view: MAIN_VIEW,
		viewport: PHONE,
		stage: withMainLine,
		prepare: async (page) => {
			await page.getByRole('button', { name: 'More' }).click();
			await page.getByRole('region', { name: 'Session details' }).waitFor();
		},
	},
	{
		name: 'phone-modes',
		view: MAIN_VIEW,
		viewport: PHONE,
		stage: withMainLine,
		prepare: async (page) => {
			await page.getByRole('button', { name: 'Listening mode' }).click();
			await page.getByRole('menu', { name: 'Listening mode' }).waitFor();
		},
	},
	{ name: 'phone-settings', view: { kind: 'settings' }, viewport: PHONE },
	{ name: 'phone-install-iphone', viewport: PHONE, phoneLink: 'iphone' },
	{
		name: 'phone-install-android',
		viewport: PHONE,
		phoneLink: 'android',
		// Chrome offers the install once it decides the page can be one: the event it fires.
		prepare: async (page) => {
			await page.evaluate(() => {
				const event = Object.assign(new Event('beforeinstallprompt'), {
					prompt: async () => undefined,
					userChoice: Promise.resolve({ outcome: 'dismissed' }),
				});

				window.dispatchEvent(event);
			});
			await page.getByRole('button', { name: 'Install' }).waitFor();
		},
	},
	{
		name: 'settings-your-phone',
		view: { kind: 'settings' },
		prepare: async (page) => {
			await page.getByRole('button', { name: 'New code' }).click();
			await page.getByRole('img', { name: "QR code of the phone's link" }).waitFor();
		},
	},
	{
		name: 'answer',
		view: { kind: 'active' },
		world: { isWrk1Asking: true },
		height: OVERVIEW_HEIGHT,
		highlight: ['.vo-row.waiting .vo-answer'],
	},
	{
		name: 'new-menu',
		view: { kind: 'active' },
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
		view: MAIN_VIEW,
		stage: withMainLine,
		around: ['section[aria-label="dev servers"]'],
		tight: true,
		highlight: ['button[aria-label="web logs"]'],
	},
	{
		name: 'dev-logs',
		view: MAIN_VIEW,
		stage: withMainLine,
		crewSetup: (crew) => crew.setDevLogs('web', WEB_LOG),
		prepare: async (page) => {
			await page.getByRole('button', { name: 'web logs' }).click();
			await page
				.getByRole('dialog', { name: 'dev server logs' })
				.getByText('$ npm run dev')
				.waitFor();
		},
	},
	{
		name: 'attachments',
		view: MAIN_VIEW,
		stage: (world) => attachTwoFiles(withMainLine(world)),
		around: ['.vo-bar'],
		highlight: ['button[aria-label="Attach files"]'],
	},
	{
		name: 'permission',
		view: MAIN_VIEW,
		stage: (world) => askToMigrate(withMainLine(world)),
		around: ['.vo-bar'],
	},
	{
		name: 'voice-off',
		view: MAIN_VIEW,
		stage: (world) =>
			play(
				[{ input: { type: 'set_voice_off', voiceOff: true }, secondsAgo: 5 }],
				withMainLine(world),
			),
		around: ['.vo-top'],
		highlight: ['.vo-top .vo-voice'],
	},
	{
		name: 'tab-drag',
		view: { kind: 'active' },
		prepare: async (page) => {
			const tabs = page.locator('.vo-tab[data-ref]');
			const from = await tabs.nth(2).boundingBox();
			const to = await tabs.nth(0).boundingBox();

			if (!from || !to) {
				throw new Error('tab-drag: the tabs are not there');
			}

			// Held mid-drag over the left half of the first tab: the drop line shows where it lands.
			await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
			await page.mouse.down();
			await page.mouse.move(to.x + 6, to.y + to.height / 2, { steps: 8 });
		},
		around: ['.vo-top'],
	},
	{ name: 'board', dir: 'setup', path: '/setup/projects' },
	{ name: 'workspaces', dir: 'setup', path: '/setup' },
	{ name: 'project', dir: 'setup', path: '/setup/project/store-api' },
	{ name: 'project-form', dir: 'setup', path: '/setup/project/store-front/edit' },
	{ name: 'worktree', dir: 'setup', path: '/setup/worktree/store/wrk1' },
	{ name: 'new-worktree', dir: 'setup', path: '/setup/workspace/store/new-worktree' },
	{ name: 'settings', dir: 'setup', path: '/setup/settings' },
	{ name: 'chat', dir: 'setup', path: '/setup/chat' },
	{ name: 'export', dir: 'setup', path: '/setup/export', height: 820 },
	{ name: 'import', dir: 'setup', path: '/setup/import', height: 420 },
	{
		name: 'logs',
		dir: 'setup',
		// A server's log opens beside the servers card's list.
		path: '/setup/worktree/store/main',
		crewSetup: (crew) => crew.setDevLogs('web', WEB_LOG),
		prepare: async (page) => {
			await page.locator('.srv-line[data-server="web"]').click();
			await page.getByRole('region', { name: 'web log' }).getByText('$ npm run dev').waitFor();
		},
		height: 620,
	},
	{ name: 'machines', dir: 'setup', path: '/setup/machine', height: 360 },
	{
		// The first run's projects step: the store's two checkouts found in ~/code, each ticked.
		name: 'first-run',
		dir: 'setup',
		path: '/',
		crew: 'empty',
		crewSetup: (crew) => {
			demoFirstRun(crew);
			const machine = crew.machines[LOCAL_MACHINE];

			if (machine) {
				machine.scan = [
					{
						name: 'store-front',
						path: `${LOCAL_HOME}/code/store-front`,
						remote: STORE_FRONT_REMOTE,
						known: false,
					},
					{
						name: 'store-api',
						path: `${LOCAL_HOME}/code/store-api`,
						remote: STORE_API_REMOTE,
						known: false,
					},
				];
			}
		},
		prepare: async (page) => {
			await startStepByStep(page);
			await page.locator(`${FIRST_RUN} [data-row="store-api"]`).waitFor({ timeout: 5000 });
		},
	},
	{
		name: 'board-phone',
		dir: 'setup',
		path: '/setup/projects',
		viewport: { width: 390, height: 844 },
	},
	{
		name: 'hero',
		view: { kind: 'session', ref: REMOTE_MAIN },
		stage: (world) =>
			play(
				[
					say(
						'Build box, store main: product cards and the cart use the CDN now, nine tests pass. The confirmation email is next.',
						REMOTE_MAIN,
					),
				],
				world,
			),
	},

	// The tutorials: a first run on an empty Mac, then the store in Set up and Voice OS.
	{ ...TUTORIAL_FIRST_RUN, name: 'first-run' },
	{
		...TUTORIAL_FIRST_RUN,
		name: 'add-by-url',
		prepare: async (page) => {
			const flow = page.locator(FIRST_RUN);

			await startStepByStep(page);
			await flow.getByRole('button', { name: 'Add by URL' }).click();
			await flow.getByRole('textbox', { name: 'Git URL' }).fill(STORE_FRONT_REMOTE);
		},
		highlight: ['main[aria-label="First run"] .fr-adder button[type="submit"]'],
	},
	{
		...TUTORIAL_FIRST_RUN,
		name: 'project-setup',
		// Slow enough to be caught with each project's detected steps under way.
		runMs: 12_000,
		prepare: async (page) => {
			await createStore(page);
			await page
				.locator('[data-runner="store-api"] [data-step]', { hasText: 'uv sync' })
				.waitFor({ timeout: 15_000 });
		},
	},
	{ ...TUTORIAL_FIRST_RUN, name: 'workspace-step', prepare: toWorkspaceStep },
	{
		...TUTORIAL_FIRST_RUN,
		name: 'ready',
		prepare: async (page) => {
			await createStore(page);
			await page
				.locator(FIRST_RUN)
				.getByRole('heading', { name: 'store/main is ready' })
				.waitFor({ timeout: 15_000 });
		},
	},
	{ name: 'board', dir: 'tutorials', path: '/setup' },
	{ name: 'project-form', dir: 'tutorials', path: '/setup/project/store-api/edit' },
	{
		name: 'binding-preview',
		dir: 'tutorials',
		path: '/setup/project/store-api/edit',
		// CORS_ORIGIN being added: store-api has no binding yet, so the form is the only place it shows.
		crewSetup: (crew) => {
			const storeApi = crew.machines[LOCAL_MACHINE]?.projects.find(
				(project) => project.name === 'store-api',
			);

			if (storeApi) {
				storeApi.bindings = [];
			}
		},
		prepare: async (page) => {
			await page.getByPlaceholder('API_URL').fill('CORS_ORIGIN');
			await page.locator('.preview').getByText('in store/main: CORS_ORIGIN=').waitFor({
				timeout: 5000,
			});
		},
		around: ['.cfg-sec:has(.preview)'],
	},
	{
		name: 'worktree',
		dir: 'tutorials',
		path: '/setup/worktree/store/main',
		prepare: async (page) => {
			await page.locator('details.env-all summary').click();
		},
	},
	{
		name: 'worktree-logs',
		dir: 'tutorials',
		path: '/setup/worktree/store/main',
		crewSetup: (crew) => crew.setDevLogs('api', API_LOG),
		prepare: async (page) => {
			await page.locator('.srv-line[data-server="api"]').click();
			await page
				.getByRole('region', { name: 'api log' })
				.getByText('Application startup complete.')
				.waitFor();
		},
	},
	{
		name: 'add-machine',
		dir: 'tutorials',
		path: '/setup/machines/new',
		prepare: async (page) => {
			const form = page.locator('section[aria-label="Add a machine"]');

			await form.getByRole('textbox', { name: 'SSH address' }).fill(`dev@${REMOTE}`);
			await form.getByRole('textbox', { name: 'Name' }).fill('Build box');
		},
	},
	{ name: 'machine-chat', dir: 'tutorials', path: `/setup/chat?on=${REMOTE}` },
	{
		name: 'discord',
		dir: 'tutorials',
		view: { kind: 'settings' },
		stage: (world) =>
			play(
				[
					{
						input: {
							type: 'discord_presence',
							presence: {
								isConnected: true,
								isOwnerIn: true,
								isHearing: true,
								channelName: 'Voice OS',
								mode: 'hands-free',
							},
						},
						secondsAgo: 60,
					},
				],
				world,
			),
		prepare: async (page) => {
			await page
				.locator('#vs-discord')
				.evaluate((section) => section.scrollIntoView({ block: 'center' }));
		},
		around: ['#vs-discord'],
		tight: true,
	},
	{ name: 'home-groups', dir: 'tutorials', view: { kind: 'active' }, stage: twoGroups },
	{
		name: 'composer-chips',
		dir: 'tutorials',
		view: MAIN_VIEW,
		stage: withMainLine,
		around: ['.vo-bar'],
	},
	{
		name: 'context-menu',
		dir: 'tutorials',
		view: MAIN_VIEW,
		// Taller than the side panel, so nothing of it sits behind the menu.
		viewport: { width: 1440, height: 1040 },
		stage: withMainLine,
		prepare: async (page) => {
			await page.locator('.ctx-meter').click();
			await page.locator('.ctx-menu').waitFor();
		},
		around: ['.vo-bar', '.ctx-menu'],
	},
	{
		name: 'ask-cards',
		dir: 'tutorials',
		view: MAIN_VIEW,
		stage: (world) => askWrk1(world),
	},
	{
		name: 'server-died',
		dir: 'tutorials',
		path: '/setup/worktree/store/wrk1',
		// wrk1 started in a shell without node on its PATH: web died at once, api and the worker run.
		crewSetup: (crew) => {
			const wrk1 = crew.machines[LOCAL_MACHINE]?.worktrees.find((row) => row.ref === WRK1);

			if (wrk1) {
				wrk1.devRunning = true;
			}

			crew.setAnswer('dev_status', () => [
				{
					worktree: WRK1,
					project: 'store-front',
					server_name: 'web',
					external_port: 5173,
					url: 'http://localhost:54030',
				},
				{
					worktree: WRK1,
					project: 'store-api',
					server_name: 'api',
					external_port: 8000,
					url: 'http://localhost:54032',
				},
				{ worktree: WRK1, project: 'store-api', server_name: 'worker', external_port: 0, url: '' },
			]);
			crew.setAnswer('dev_check', () => [
				{
					project: 'store-front',
					server: 'web',
					port: 54030,
					alive: false,
					listening: false,
					referenced: true,
					tail: 'zsh: command not found: npm',
					took_ms: 4000,
				},
				{
					project: 'store-api',
					server: 'api',
					port: 54032,
					alive: true,
					listening: true,
					referenced: true,
					took_ms: 2400,
				},
				{
					project: 'store-api',
					server: 'worker',
					port: 0,
					alive: true,
					listening: false,
					referenced: false,
					took_ms: 4000,
				},
			]);
			crew.setDevLogs('web', ['$ npm run dev', 'zsh: command not found: npm']);
		},
		prepare: async (page) => {
			await page
				.getByRole('region', { name: 'web log' })
				.getByText('zsh: command not found: npm')
				.waitFor({ timeout: 5000 });
		},
		height: 640,
	},
	{
		name: 'remove-worktree',
		dir: 'tutorials',
		path: '/setup/worktree/store/wrk1',
		prepare: async (page) => {
			await page.getByRole('button', { name: 'Remove worktree' }).click();
			await page.locator('.confirm .cost').waitFor({ timeout: 5000 });
			await page.locator('.confirm').scrollIntoViewIfNeeded();
		},
		around: ['.confirm'],
	},
	{
		name: 'worktree-value',
		dir: 'tutorials',
		path: '/setup/worktree/store/wrk1',
		crewSetup: (crew) => {
			const wrk1 = crew.machines[LOCAL_MACHINE]?.worktrees.find((row) => row.ref === WRK1);

			if (wrk1) {
				wrk1.overrides = { 'store-front.VITE_API_URL': 'http://localhost:9999' };
			}
		},
		prepare: async (page) => {
			await page.locator('[data-override="store-front.VITE_API_URL"]').waitFor({ timeout: 5000 });
			await page.locator('details.env-all summary').click();
		},
		around: ['.label:has(.label-note)', '.env-card'],
	},
	{
		name: 'import-plan',
		dir: 'tutorials',
		path: '/setup/import',
		crew: 'empty',
		// A new Mac that already has store-front: the export brings store-api and the workspace.
		crewSetup: (crew) => {
			demoFirstRun(crew);
			const machine = crew.machines[LOCAL_MACHINE];
			const [storeFront] = demoProjects(LOCAL_HOME);

			if (machine && storeFront) {
				machine.projects = [storeFront];
			}
		},
		prepare: async (page) => {
			const file = join(mkdtempSync(join(tmpdir(), 'crew-docs-import-')), 'crew-export.json');
			const bundle = {
				version: 2,
				projects: demoProjects(LOCAL_HOME).map(({ path: _path, ...project }) => project),
				workspaces: [
					{
						name: 'store',
						projects: [
							{ name: 'store-front', mode: 'worktree' },
							{ name: 'store-api', mode: 'worktree' },
						],
					},
				],
			};

			writeFileSync(file, JSON.stringify(bundle));
			await page.getByLabel('Export file').setInputFiles(file);
			await page.locator('[data-project="store-api"]').waitFor({ timeout: 5000 });
		},
	},
	{
		name: 'machine-picker',
		dir: 'tutorials',
		path: '/setup',
		prepare: async (page) => {
			await page.locator('.machine-btn').click();
			await page.locator('.machine-menu').waitFor();
		},
		around: ['.machine-pick', '.machine-menu'],
		tight: true,
	},
	{
		name: 'machine-connection',
		dir: 'tutorials',
		path: `/setup/machine?on=${REMOTE}`,
	},
	{
		name: 'trust-devices',
		dir: 'tutorials',
		path: '/setup/settings',
		prepare: async (page) => {
			await page.getByRole('button', { name: 'Trust on other devices' }).click();
			await page.locator('form.cfg-sec .result-line').waitFor({ timeout: 5000 });
		},
		around: ['form.cfg-sec'],
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
	const viewport = shot.viewport ?? VIEWPORT;
	const context = await browser.newContext({
		viewport,
		...(viewport.width <= PHONE.width ? { deviceScaleFactor: 2, hasTouch: true } : {}),
		...(shot.phoneLink ? { userAgent: PHONE_AGENTS[shot.phoneLink] } : {}),
		permissions: ['microphone'],
		// The page at rest: no opening, no moment, no page rise.
		reducedMotion: 'reduce',
	});

	// Localhost only: nothing leaves the machine.
	await context.route('**/*', (route) =>
		new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort(),
	);

	if (shot.phoneLink) {
		// What the server's /phone/<key> page sets; the shot stays on /voice, which needs no key.
		await context.addInitScript(() => {
			Object.assign(window, { __VOICEOS_PHONE__: true });
		});
	}

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
		await page.waitForSelector('.vo-top, .mtop, .inst, .top, .launcher, .first-run');
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
// A name takes every shot of that name; <dir>/<name> (setup/settings) takes one.
const shotId = (shot: Shot): string => `${shot.dir ?? 'voice-os'}/${shot.name}`;

const isPicked = (shot: Shot, only: string[]): boolean =>
	only.length === 0 || only.includes(shot.name) || only.includes(shotId(shot));

const readOnlyShots = (): string[] => {
	const only = process.argv.slice(2);
	const known = SHOTS.flatMap((shot) => [shot.name, shotId(shot)]);
	const unknown = only.filter((name) => !known.includes(name));

	if (unknown.length > 0) {
		throw new Error(
			`unknown shot ${unknown.join(', ')}; shots are: ${SHOTS.map(shotId).join(', ')}`,
		);
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

		for (const shot of SHOTS.filter((shot) => isPicked(shot, only))) {
			const world = buildWorld(shot.world);
			const staged = shot.stage ? shot.stage(world) : world;

			crew = createFakeCrew({
				seed: shot.crew === 'empty' ? 'empty' : 'golden',
				remotes: [REMOTE],
				...(shot.runMs ? { runMs: shot.runMs } : {}),
			});

			if (shot.crew !== 'empty') {
				demoCrew(crew);
			}

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
