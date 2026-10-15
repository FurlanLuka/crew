// Set up's chat drawn from a state: Voice OS's session pieces (stream, draft, compaction, the ask
// dock, the queue, sub-agents) on the setup session, with nothing to say aloud.
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PendingAsk, Session, State } from '../../shared/protocol.js';
import { createInitialState, createSession } from '../../state/reducer.js';
import { SessionStream } from '../components/SessionStream.js';
import type { SetupContext } from './common.js';
import { SetupChat } from './SetupChat.js';
import type { AskedFocus } from './focus.js';
import { setupRefFor } from './SetupShell.js';

const noop = () => undefined;

const setupSession = (ref: string, patch: Partial<Session> = {}): Session => ({
	...createSession({
		ref,
		label: 'setup',
		branch: '',
		cwd: '/Users/dev',
		dirs: [],
		isPinned: true,
	}),
	...patch,
});

const question = (ref: string): PendingAsk => ({
	id: `q-${ref}`,
	ref,
	at: 1,
	kind: 'question',
	input: {},
	questions: [
		{
			question: 'How should the worker reach Redis?',
			header: 'Environment',
			multiSelect: false,
			options: [{ label: 'I have Redis on :6379' }, { label: 'Skip the worker' }],
		},
	],
});

const createContext = (state: State, machine = 'local'): SetupContext => ({
	state,
	machine,
	machineTitle: machine === 'local' ? 'This Mac' : 'Build box',
	go: noop,
	askClaude: noop,
	tellClaude: noop,
	send: noop,
	openVoice: noop,
});

const renderChat = (state: State, machine = 'local', askedFocus: AskedFocus | null = null) =>
	renderToStaticMarkup(
		<SetupChat
			ctx={createContext(state, machine)}
			draft=""
			onDraftUsed={noop}
			askedFocus={askedFocus}
		/>,
	);

describe('SessionStream', () => {
	it('the lines, the reply still arriving with its caret, the compaction bar and the slots', () => {
		const session = setupSession('setup', {
			stream: [
				{ id: 's1', at: 1, kind: 'user', text: 'add signals' },
				{ id: 's2', at: 2, kind: 'tool', name: 'Bash', summary: 'run crew ls projects' },
			],
			draft: 'Reading the **repo**',
			compactingSince: 1,
		});
		const html = renderToStaticMarkup(
			<SessionStream
				sessionRef="setup"
				session={session}
				className="chat"
				renderAfter={(item) => (item.id === 's2' ? <i>after</i> : null)}
			>
				<p>the end</p>
			</SessionStream>,
		);

		expect(html).toContain('› add signals');
		expect(html).toContain('<div class="stream-item"><div class="line tool">');
		expect(html).toContain('<i>after</i>');
		expect(html).toContain('<strong>repo</strong></p></div><span class="caret"></span>');
		expect(html).toContain('Compacting context…');
		expect(html.endsWith('<p>the end</p></section>')).toBe(true);
	});

	it('no session yet → only what the page adds', () =>
		expect(
			renderToStaticMarkup(
				<SessionStream sessionRef="setup" session={undefined} className="chat">
					<p>not yet</p>
				</SessionStream>,
			),
		).toBe('<section class="chat" aria-label="stream"><p>not yet</p></section>'));
});

describe('SetupChat', () => {
	it("the setup session's question docked above the composer, its queued words, the draft and ✓ recorded", () => {
		const state: State = {
			...createInitialState(),
			sessions: {
				setup: setupSession('setup', {
					status: 'running',
					stream: [
						{
							id: 's1',
							at: 1,
							kind: 'tool',
							name: 'Bash',
							summary: 'run crew dev add signals --name=web --port=3000',
						},
						{ id: 's2', at: 2, kind: 'tool_result', ok: true, summary: 'Added dev server' },
					],
					draft: 'Checking the worker',
					queue: [{ id: 'm1', text: 'then look at admin', at: 3 }],
					subagents: [
						{
							taskId: 't1',
							agentType: 'Explore',
							description: 'read the compose file',
							startedAt: 1,
							step: null,
							isBackground: false,
						},
					],
				}),
			},
			asks: [question('setup')],
		};
		const html = renderChat(state);
		const foot = html.slice(html.indexOf('class="ss-foot"'));

		expect(html).toContain('✓ recorded · Dev server: web :3000');
		expect(html).toContain('Checking the worker</p></div><span class="caret"></span>');
		expect(foot).toContain('sub-agents · 1');
		expect(foot.indexOf('sub-agents · 1')).toBeLessThan(foot.indexOf('aria-label="question"'));
		expect(foot.indexOf('aria-label="question"')).toBeLessThan(foot.indexOf('aria-label="queued"'));
		// Set up keeps its queue as rows under the ask, not folded into a chip.
		expect(foot).toContain('then look at admin');
		expect(foot).not.toContain('qchip');
		expect(foot.indexOf('then look at admin')).toBeLessThan(foot.indexOf('class="reply"'));
		expect(foot).toContain('class="sheet question"');
		expect(foot).toContain('Decline the question');
		expect(foot).toContain('Something else…');
		expect(html).toContain('>Queue</button>');
		// Answered here, never heard: no words to say.
		expect(foot).not.toContain('sh-say');
	});

	it("a remote machine's chat shows that machine's setup ask, never this Mac's", () => {
		const state: State = {
			...createInitialState(),
			sessions: { setup: setupSession('setup'), 'vm1:setup': setupSession('vm1:setup') },
			asks: [question('setup'), { ...question('vm1:setup'), id: 'remote-q' }],
		};
		const html = renderChat(state, 'vm1');

		expect(html).toContain('How should the worker reach Redis?');
		expect(html.match(/aria-label="question"/g)).toHaveLength(1);
		expect(renderChat({ ...state, asks: [question('setup')] }, 'vm1')).not.toContain(
			'aria-label="question"',
		);
	});
});

describe('setupRefFor', () => {
	it("this Mac's is setup, another machine's is prefixed with its id", () => {
		expect(setupRefFor('local')).toBe('setup');
		expect(setupRefFor('vm1')).toBe('vm1:setup');
	});
});

describe('the worktree beside the chat', () => {
	it('a Fix with Claude names its worktree → the panel shows it before anything is sent', () => {
		const html = renderChat(createInitialState(), 'local', { ref: 'store/wrk1', afterIndex: 0 });

		expect(html).toContain('aria-label="store/wrk1 beside the chat"');
		expect(html).toContain('with-panel');
	});

	it('nothing named → the plain chat', () => {
		const html = renderChat(createInitialState());

		expect(html).not.toContain('beside the chat');
		expect(html).not.toContain('with-panel');
	});
});
