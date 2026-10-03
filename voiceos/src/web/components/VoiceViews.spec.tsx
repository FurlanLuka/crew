// Voice OS's views, drawn from a state: Activate, Settings, the moments row, the ask dock and the
// state row.
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PendingAsk, State } from '../../shared/protocol.js';
import { createInitialState, createSession } from '../../state/reducer.js';
import { Activate, describeGroup, listActivateSections } from './Activate.js';
import { ActiveView, sortForHome } from './ActiveView.js';
import { listRecentFolders, NewSessionDialog } from './NewSessionDialog.js';
import { AskDock } from './AskDock.js';
import { Cockpit } from './Cockpit.js';
import { DevLogsDialog, isErrorLine } from './DevLogsDialog.js';
import { DevPanel } from './DevPanel.js';
import { MomentsRow } from './MomentsRow.js';
import { SessionStateRow } from './SessionStateRow.js';
import { Settings } from './Settings.js';

const noop = () => undefined;

const renderActivate = (state: State, machine?: string) =>
	renderToStaticMarkup(
		<Activate
			state={state}
			dispatch={noop}
			{...(machine ? { machine } : {})}
			onNewSession={noop}
			onSetUpMachine={noop}
		/>,
	);

const createState = (patch: Partial<State> = {}): State => {
	const refs = [
		'setup',
		'store-front/main',
		'store-front/wrk1',
		'checkout-api/main',
		'vm1:api/main',
	];

	return {
		...createInitialState(),
		sessions: Object.fromEntries(
			refs.map((ref) => [
				ref,
				createSession({
					ref,
					label: ref,
					branch: 'b',
					cwd: '/w',
					dirs: [],
					isPinned: ref === 'setup',
				}),
			]),
		),
		order: refs,
		active: ['store-front/main'],
		machines: {
			vm1: {
				id: 'vm1',
				host: 'dev@vm1',
				name: 'Build box',
				status: 'connected',
				detail: null,
				since: 1,
			},
		},
		...patch,
	};
};

describe('Activate', () => {
	it('every worktree by machine then workspace, never the setup session', () => {
		const sections = listActivateSections(createState(), 'all', '');

		expect(
			sections.map((section) => [
				section.title,
				section.status,
				section.groups.map((group) => group.workspace),
			]),
		).toEqual([
			['This Mac', '1 of 3 active', ['store-front', 'checkout-api']],
			['Build box', '0 of 1 active', ['api']],
		]);
	});

	it('a plain session sits under "Plain sessions" by its name, and every machine offers a New session', () => {
		const state = createState();
		const chat = createSession({
			ref: 'chat/3fa9c1',
			label: 'research',
			branch: '',
			cwd: '/Users/dev',
			dirs: [],
			isPinned: false,
			isChat: true,
		});
		const withChat = {
			...state,
			sessions: { ...state.sessions, 'chat/3fa9c1': chat },
			order: [...state.order, 'chat/3fa9c1'],
		};

		expect(listActivateSections(withChat, 'all', 'research')[0]?.groups).toEqual([
			{ workspace: 'chat', refs: ['chat/3fa9c1'] },
		]);
		expect(describeGroup('chat')).toBe('Plain sessions');
		expect(describeGroup('store-front')).toBe('store-front');

		const html = renderActivate(withChat);

		expect(html).toContain('<b>Plain sessions</b>');
		expect(html).toContain('<b>research</b>');
		// Each machine's heading and its plain sessions' "start another" row.
		expect(html.split('>New session<').length - 1).toBe(4);
		expect(html).toContain('Start another in any folder on This Mac.');
		expect(html).toContain('Start one in any folder on Build box.');
	});

	it('the search narrows to matching worktrees; a machine with none drops out', () =>
		expect(
			listActivateSections(createState(), 'all', 'checkout').map((section) => section.title),
		).toEqual(['This Mac']));

	it('an active worktree links to its session; an inactive one has Activate', () => {
		const html = renderActivate(createState());

		expect(html).toContain('<span class="chip ok">active</span>');
		expect(html).toMatch(/data-ref="store-front\/wrk1"[\s\S]*?Activate<\/button>/);
		expect(html).toContain('All machines');
	});

	it('a machine out of reach: its rows dimmed and Activate disabled', () => {
		const html = renderActivate(
			createState({
				machines: {
					vm1: {
						id: 'vm1',
						host: 'vm1',
						name: 'Build box',
						status: 'unreachable',
						detail: 'not reachable · last seen 2h ago',
						since: 1,
					},
				},
			}),
		);

		expect(html).toContain('vb-sec off');
		expect(html).toContain('not reachable · last seen 2h ago');
		expect(html).toContain('disabled=""');
	});

	it('words waiting for an inactive worktree are shown on its row', () => {
		const state = createState();
		const wrk1 = state.sessions['store-front/wrk1'];

		if (wrk1) {
			state.sessions['store-front/wrk1'] = {
				...wrk1,
				queue: [{ id: 'q1', text: 'paginate the orders', at: 1 }],
			};
		}

		expect(renderActivate(state)).toContain('1 waiting: “paginate the orders”');
	});
});

describe('a machine page', () => {
	it('one machine → its name and status, its host, Open in Set up and New session on it', () => {
		const html = renderActivate(createState(), 'vm1');

		expect(html).toMatch(/<h1>Build box<span class="chip ok">connected<\/span><\/h1>/);
		expect(html).toContain('dev@vm1');
		expect(html).toContain('>Open in Set up</button>');
		expect(html).toContain('>New session on Build box</button>');
		expect(html).not.toContain('class="vb-machine"');
	});

	it('This Mac → main, never Open in Set up', () => {
		const html = renderActivate(createState(), 'local');

		expect(html).toMatch(/<h1>This Mac<span class="chip ok">main<\/span><\/h1>/);
		expect(html).not.toContain('Open in Set up');
	});

	it('a machine out of reach → no new session there', () =>
		expect(
			renderActivate(
				createState({
					machines: {
						vm1: {
							id: 'vm1',
							host: 'dev@vm1',
							name: 'Build box',
							status: 'unreachable',
							detail: null,
							since: 1,
						},
					},
				}),
				'vm1',
			),
		).toMatch(/disabled=""[^>]*>New session on Build box</));
});

describe('Home', () => {
	const asking: PendingAsk = {
		id: 'q9',
		ref: 'checkout-api/main',
		at: 1,
		kind: 'question',
		input: {},
		questions: [{ question: 'Postgres or SQLite?', multiSelect: false, options: [] }],
	};
	const home = createState({
		active: ['store-front/main', 'checkout-api/main'],
		asks: [asking],
	});
	const render = (state: State) =>
		renderToStaticMarkup(<ActiveView state={state} dispatch={noop} onNewSession={noop} />);

	it('what waits on you first, tinted, with Answer; the rest in the order activated', () => {
		expect(sortForHome(home, ['store-front/main', 'checkout-api/main'])).toEqual([
			'checkout-api/main',
			'store-front/main',
		]);

		const html = render(home);

		expect(html.indexOf('data-ref="checkout-api/main"')).toBeLessThan(
			html.indexOf('data-ref="store-front/main"'),
		);
		expect(html).toMatch(/vo-row waiting[^>]*data-ref="checkout-api\/main"[\s\S]*?>Answer</);
		expect(html).toContain('2 sessions on 1 machine. One needs you.');
	});

	it('New session and Activate a worktree up top; a card per machine with what it holds', () => {
		const html = render(home);

		expect(html).toContain('>New session</button>');
		expect(html).toContain('>Activate a worktree</button>');
		expect(html).toMatch(
			/data-machine="local"[\s\S]*?This Mac[\s\S]*?main[\s\S]*?3 worktrees · 2 active/,
		);
		expect(html).toMatch(
			/data-machine="vm1"[\s\S]*?Build box[\s\S]*?dev@vm1[\s\S]*?1 worktree · 0 active/,
		);
		expect(html).toContain('Or just say it');
	});

	it('a machine out of reach → its card says why instead of counts', () =>
		expect(
			render(
				createState({
					machines: {
						vm1: {
							id: 'vm1',
							host: 'dev@vm1',
							name: 'Build box',
							status: 'unreachable',
							detail: 'not reachable · last seen 2h ago',
							since: 1,
						},
					},
				}),
			),
		).toMatch(/data-machine="vm1"[\s\S]*?dot ask[\s\S]*?not reachable · last seen 2h ago/));
});

describe('New session dialog', () => {
	it('a machine out of reach is not offered; opened on it, the dialog falls back to This Mac', () => {
		const html = renderToStaticMarkup(
			<NewSessionDialog
				state={createState({
					machines: {
						vm1: {
							id: 'vm1',
							host: 'dev@vm1',
							name: 'Build box',
							status: 'unreachable',
							detail: null,
							since: 1,
						},
					},
				})}
				machine="vm1"
				dispatch={noop}
				onClose={noop}
			/>,
		);

		expect(html).toContain('aria-label="New session on This Mac"');
		expect(html).not.toContain('Build box');
	});

	it("the folders already used for plain sessions on that machine, each once; never another machine's", () => {
		const chat = (ref: string, cwd: string) =>
			createSession({ ref, label: ref, branch: '', cwd, dirs: [], isPinned: false, isChat: true });
		const state = createState();
		const withChats = {
			...state,
			sessions: {
				...state.sessions,
				'chat/a00001': chat('chat/a00001', '/Users/dev/notes'),
				'chat/a00002': chat('chat/a00002', '/Users/dev/notes'),
				'chat/a00003': chat('chat/a00003', '/Users/dev/w/store-front'),
				'vm1:chat/a00004': chat('vm1:chat/a00004', '/var/log'),
			},
		};

		expect(listRecentFolders(withChats, 'local')).toEqual([
			'/Users/dev/notes',
			'/Users/dev/w/store-front',
		]);
		expect(listRecentFolders(withChats, 'vm1')).toEqual(['/var/log']);
	});
});

describe('Settings', () => {
	const render = (state: State) =>
		renderToStaticMarkup(
			<Settings
				state={state}
				dispatch={noop}
				listenMode="hands-free"
				onListenMode={noop}
				onSetUpMachine={noop}
			/>,
		);

	it('the four listening modes, the chosen one pressed; no language list (Soniox detects it)', () => {
		const html = render(createState());

		for (const name of ['Push to talk', 'On demand', 'Hands-free', 'Dictation']) {
			expect(html).toContain(name);
		}

		expect(html).toMatch(/aria-pressed="true"><b>Hands-free<\/b>/);
		expect(html).not.toContain('Languages you speak');
	});

	it('a missing key → red with Add; a set one → Replace', () => {
		const html = render(
			createState({ setup: { missing: ['/home/dev/.config/crew-voiceos/anthropic.key'] } }),
		);

		expect(html).toMatch(/data-key="anthropic"[\s\S]*?dot ask[\s\S]*?Add<\/button>/);
		expect(html).toMatch(/data-key="soniox"[\s\S]*?dot ok[\s\S]*?Replace<\/button>/);
	});

	it('Discord not set up → the four steps; set up → connected with Turn off', () => {
		expect(render(createState())).toContain('crew server discord setup');
		expect(
			render(
				createState({
					discord: {
						isConnected: true,
						isOwnerIn: false,
						isHearing: true,
						channelName: 'Voice OS',
						mode: 'hands-free',
					},
				}),
			),
		).toContain('Turn off');
	});

	it('a side menu to every section; Voice says whether it is on, with its one button', () => {
		const html = render(createState());

		for (const name of ['Listening', 'Voice', 'Keys', 'Discord', 'Names', 'Machines']) {
			expect(html).toContain(`>${name}</button>`);
		}

		expect(html).toContain('<b>Voice is on</b>');
		expect(html).toContain('>Mute voice</button>');
		expect(render(createState({ voiceOff: true }))).toContain('>Turn voice on</button>');
	});

	it('names, and the machines with how they are reached', () => {
		const html = render(createState({ names: { 'checkout-api/main': 'checkout' } }));

		expect(html).toContain('<b>checkout</b>');
		expect(html).toContain('ssh dev@vm1 · connected');
		expect(html).toContain('Always open Voice OS');
	});
});

describe('MomentsRow', () => {
	it('a switch offer → its words, what to say, and the answers as buttons', () => {
		const html = renderToStaticMarkup(
			<MomentsRow
				state={createState({ switchOffer: { ref: 'checkout-api/main', at: 1 } })}
				dispatch={noop}
			/>,
		);

		expect(html).toContain('Sent to checkout-api/main. Switch there?');
		expect(html).toContain('say yes, or keep talking');
		expect(html).toContain('>Switch</button>');
		expect(html).toContain('>Stay here</button>');
	});

	it('nothing asked → nothing drawn', () =>
		expect(renderToStaticMarkup(<MomentsRow state={createState()} dispatch={noop} />)).toBe(''));
});

const QUESTION: PendingAsk = {
	id: 'q1',
	ref: 'store-front/main',
	at: 1,
	kind: 'question',
	input: {},
	questions: [
		{
			question: 'A new events table, or a column on orders?',
			multiSelect: false,
			options: [{ label: 'A new events table' }, { label: 'A column on orders' }],
		},
	],
};

describe('AskDock', () => {
	it('a question → its options as buttons, how to say one, and an X to decline it', () => {
		const html = renderToStaticMarkup(
			<AskDock ask={QUESTION} label="store-front/main" dispatch={noop} />,
		);

		expect(html).toContain('A new events table, or a column on orders?');
		expect(html).toContain('A column on orders');
		expect(html).toContain('Your own answer…');
		expect(html).toContain('aria-label="Decline the question"');
		expect(html).toContain('title="Decline the question"');
	});

	it('a plan keeps its own way to say no: no X', () =>
		expect(
			renderToStaticMarkup(
				<AskDock
					ask={{ id: 'p1', ref: 'store-front/main', at: 1, kind: 'plan', input: {}, plan: 'p' }}
					label="store-front/main"
					dispatch={noop}
				/>,
			),
		).not.toContain('Decline the question'));
});

describe('SessionStateRow', () => {
	it('an open ask → no row: it is docked above the voice bar', () =>
		expect(
			renderToStaticMarkup(
				<SessionStateRow
					state={createState({ asks: [QUESTION] })}
					sessionRef="store-front/main"
					dispatch={noop}
				/>,
			),
		).toBe(''));

	it('a crash → "Claude stopped unexpectedly" with Restart, its only control', () => {
		const state = createState();
		const session = state.sessions['store-front/main'];

		if (session) {
			state.sessions['store-front/main'] = { ...session, status: 'stopped', error: 'exit 1' };
		}

		const html = renderToStaticMarkup(
			<SessionStateRow state={state} sessionRef="store-front/main" dispatch={noop} />,
		);

		expect(html).toContain('Claude stopped unexpectedly');
		expect(html).toContain('nothing you said was lost');
		expect(html).toContain('>Restart</button>');
		// No log button: Voice OS has no per-session log to show, and a dead control is worse than none.
		expect(html.match(/<button/g)).toHaveLength(1);
	});

	it('a remote that dropped → reconnecting, your words wait', () =>
		expect(
			renderToStaticMarkup(
				<SessionStateRow
					state={createState({
						machines: {
							vm1: {
								id: 'vm1',
								host: 'vm1',
								name: 'Build box',
								status: 'unreachable',
								detail: null,
								since: 1,
							},
						},
					})}
					sessionRef="vm1:api/main"
					dispatch={noop}
				/>,
			),
		).toContain('Build box dropped'));
});

describe("the session's Dev servers panel", () => {
	const renderCockpit = (state: State) =>
		renderToStaticMarkup(
			<Cockpit
				session={state.sessions['store-front/main'] as NonNullable<State['sessions'][string]>}
				state={state}
				dispatch={noop}
			/>,
		);

	it('nothing to start (crew lists no dev server for the worktree) → no panel at all', () => {
		const html = renderCockpit(createState());

		expect(html).not.toContain('aria-label="dev servers"');
		expect(html).not.toContain('start dev servers');
		expect(html.toLowerCase()).not.toContain('not set up');
	});

	it('running servers → the panel, each server one row, nothing about projects without servers', () => {
		const html = renderCockpit(
			createState({
				devServers: {
					'store-front/main': [
						{
							name: 'web',
							port: 3000,
							url: 'http://localhost:3000',
							state: 'running',
							detail: null,
						},
					],
				},
			}),
		);

		expect(html).toContain('aria-label="dev servers"');
		expect(html).toContain('data-server="web"');
		// The link is an icon with the URL in its label, never the URL as text.
		expect(html).toContain('aria-label="Open web (localhost:3000)"');
		expect(html).not.toContain('>localhost:3000');
		expect(html.toLowerCase()).not.toContain('not set up');
	});

	it('starting, before crew answers or anything runs → the panel, saying so', () => {
		const html = renderCockpit(createState({ devStarting: ['store-front/main'] }));

		expect(html).toContain('aria-label="dev servers"');
		expect(html).toContain('starting…');
	});

	it('a panel with nothing running offers Start, and never a Set up link', () => {
		const html = renderToStaticMarkup(
			<DevPanel
				worktree="store-front/main"
				servers={[]}
				isStarting={false}
				offer={null}
				dispatch={noop}
			/>,
		);

		expect(html).toContain('not running');
		expect(html).toContain('Start · “start dev servers”');
		expect(html).not.toContain('Set up');
	});
});

describe('dev server logs', () => {
	const SERVERS = [
		{ name: 'web', port: 4120, url: 'http://localhost:4120', state: 'running', detail: null },
		{ name: 'api', port: 4121, url: null, state: 'died', detail: null },
	] as const;

	it('every server row has its logs button, before the open link when there is one', () => {
		const html = renderToStaticMarkup(
			<DevPanel
				worktree="store-front/main"
				servers={[...SERVERS]}
				isStarting={false}
				offer={null}
				dispatch={noop}
			/>,
		);

		expect(html).toMatch(/data-server="web"[\s\S]*?aria-label="web logs"[\s\S]*?Open web/);
		expect(html).toMatch(/data-server="api"[\s\S]*?aria-label="api logs"/);
	});

	it('the window says whose log it is, its state and where it listens', () => {
		const html = renderToStaticMarkup(
			<DevLogsDialog
				worktree="vm1:store-front/main"
				servers={[...SERVERS]}
				first="api"
				dispatch={noop}
				onClose={noop}
			/>,
		);

		expect(html).toContain('dev server · vm1:store-front/main');
		expect(html).toMatch(/api <span class="c-crit">· died<\/span>/);
		expect(html).toContain('port 4121 · following, new lines as they come');
		expect(html).toContain('>Restart dev servers<');
		// A tab per server, the one clicked chosen.
		expect(html).toMatch(/aria-pressed="false"><span class="dot ok"><\/span>web</);
		expect(html).toMatch(/aria-pressed="true"><span class="dot ask"><\/span>api</);
	});

	it('error lines stand out; ordinary ones do not', () => {
		for (const line of [
			'Traceback (most recent call last):',
			'ERROR:    Application startup failed.',
			'GET /api/cart 502 (proxy: connect ECONNREFUSED 127.0.0.1:4121)',
			'panic: runtime error: index out of range',
		]) {
			expect(isErrorLine(line)).toBe(true);
		}

		for (const line of ['ready on http://localhost:3000', 'GET / 200 4 ms', 'errors=0 ok']) {
			expect(isErrorLine(line)).toBe(false);
		}
	});
});

describe('a plain session page', () => {
	it('a Remove button, no Dev servers panel; a worktree page has no Remove', () => {
		const state = createState();
		const chat = createSession({
			ref: 'chat/3fa9c1',
			label: 'research',
			branch: '',
			cwd: '/Users/dev',
			dirs: [],
			isPinned: false,
			isChat: true,
		});
		const render = (session: NonNullable<State['sessions'][string]>) =>
			renderToStaticMarkup(<Cockpit session={session} state={state} dispatch={noop} />);

		const html = render(chat);

		expect(html).toContain('>Remove<');
		expect(html).not.toContain('aria-label="dev servers"');
		expect(
			render(state.sessions['store-front/main'] as NonNullable<State['sessions'][string]>),
		).not.toContain('>Remove<');
	});
});
