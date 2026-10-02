// Set up's pieces, drawn from crew's answers: the problems strip, the Setup with Claude card, and
// the first run at each stage.
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import type { State } from '../../shared/protocol.js';
import { createInitialState, createSession } from '../../state/reducer.js';
import { ClaudeCard, ProblemsStrip } from './Board.js';
import type { SetupContext } from './common.js';
import { listProblems } from './derive.js';
import type { CrewProject } from './types.js';
import { WelcomeSteps } from './Welcome.js';

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

const PROJECT: CrewProject = { name: 'store-front', path: '/code/store-front', remote: '' };

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

describe('Welcome', () => {
	const render = (pool: CrewProject[], created: string | null = null) =>
		renderToStaticMarkup(
			<WelcomeSteps
				ctx={createCtx()}
				pool={pool}
				created={created}
				onAdded={noop}
				onCreated={noop}
				onBoard={noop}
			/>,
		);

	it('nothing yet → step 1, pick projects, is open; step 2 waits', () => {
		const html = render([]);

		expect(html).toMatch(/fr-step now"[^>]*>[\s\S]*?Pick your projects/);
		expect(html).toContain('fr-step later');
		expect(html).toContain('Add by URL or path');
	});

	it('projects added → step 1 done with what was added; make a workspace, the first project picked', () => {
		const html = render([PROJECT, { ...PROJECT, name: 'checkout-api' }]);

		expect(html).toContain('2 added: store-front, checkout-api');
		expect(html).toContain('Workspace name');
		expect(html).toContain('value="store-front"');
		expect(html).toContain('crew add workspace store-front store-front');
	});

	it('a workspace made → its progress, read from crew', () =>
		expect(render([PROJECT], 'store-front')).toContain('Waiting for crew&#x27;s runners…'));
});
