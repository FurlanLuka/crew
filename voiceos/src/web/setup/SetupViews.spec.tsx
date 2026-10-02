// Set up's pieces, drawn from crew's answers: the problems strip, the Setup with Claude card, and
// the first run where it starts.
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import type { State } from '../../shared/protocol.js';
import { createInitialState, createSession } from '../../state/reducer.js';
import { FirstRun } from '../home/FirstRun.js';
import { ClaudeCard, ProblemsStrip } from './Board.js';
import type { SetupContext } from './common.js';
import { listProblems } from './derive.js';

const noop = () => undefined;

const createCtx = (state: State = createInitialState()): SetupContext => ({
	state,
	machine: LOCAL_MACHINE,
	machineTitle: 'This Mac',
	go: noop,
	askClaude: noop,
	send: noop,
	openVoice: noop,
});

const withSetup = (patch: Partial<State> = {}): State => ({
	...createInitialState(),
	sessions: {
		setup: createSession({
			ref: 'setup',
			label: 'setup',
			branch: '',
			cwd: '/',
			dirs: [],
			isPinned: true,
		}),
	},
	...patch,
});

describe('ProblemsStrip', () => {
	it('a failure has Fix and Fix with Claude; nothing else is a problem', () => {
		const problems = listProblems([
			{
				ref: 'admin/main',
				path: '/w',
				dev_running: false,
				installing: false,
				issues: [
					{
						stage: 'smoke',
						project: 'admin',
						server: 'web',
						reason: 'died',
						detail: "Cannot find module 'next'",
					},
				],
			},
		]);
		const html = renderToStaticMarkup(<ProblemsStrip ctx={createCtx()} problems={problems} />);

		expect(html).toContain('web died · Cannot find module &#x27;next&#x27;');
		expect(html).toContain('>Fix</button>');
		expect(html).toContain('>Fix with Claude</button>');
		expect(html).not.toContain('quiet');
		expect(html).not.toContain('Set up');
	});
});

describe('ClaudeCard', () => {
	it('free → a field to ask anything', () =>
		expect(renderToStaticMarkup(<ClaudeCard ctx={createCtx(withSetup())} />)).toContain(
			'aria-label="Ask setup"',
		));

	it('working or waiting on you → says so, with Open only', () => {
		const state = withSetup({
			asks: [{ id: 'a1', ref: 'setup', at: 1, kind: 'plan', input: {}, plan: 'p' }],
		});
		const html = renderToStaticMarkup(<ClaudeCard ctx={createCtx(state)} />);

		expect(html).toContain('waiting on you');
		expect(html).toContain('>Open</button>');
		expect(html).not.toContain('aria-label="Ask setup"');
	});
});

describe('FirstRun', () => {
	const render = (resume: string | null) =>
		renderToStaticMarkup(
			<FirstRun resume={resume} openVoice={noop} askClaude={noop} goSetup={noop} />,
		);

	it('a fresh first run → the opening: the wordmark and Get started, no steps yet', () => {
		const html = render(null);

		expect(html).toContain('data-stage="intro"');
		expect(html).toContain('your sessions, every machine');
		expect(html).toContain('Get started');
		expect(html).not.toContain('fr-progress');
	});

	it('opened while its worktree installs → straight to its progress, the third step current', () => {
		const html = render('store-front/main');

		expect(html).toContain('Getting store-front/main ready');
		expect(html).toMatch(/<li[^>]*aria-current="step"[^>]*>\s*Getting it ready</);
		expect(html).not.toContain('Get started');
	});
});
