import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SubagentRun } from '../../shared/protocol.js';
import { SubagentDialog } from './SubagentDialog.js';
import { SubagentsPanel } from './SubagentsPanel.js';
import { StreamLine } from './StreamLine.js';
import { SessionStream } from './SessionStream.js';
import { createSession } from '../../state/reducer.js';

const RUN: SubagentRun = {
	taskId: 't1',
	toolUseId: 'toolu_1',
	agentType: 'Explore',
	description: 'Find the router',
	startedAt: 0,
	items: [
		{ id: 'a', at: 1, kind: 'tool', name: 'Grep', summary: 'search for route' },
		{ id: 'b', at: 2, kind: 'tool_result', ok: false, summary: 'no match' },
		{ id: 'c', at: 3, kind: 'text', text: 'It lives in **src/router.ts**.' },
	],
};

const render = (isRunning: boolean) =>
	renderToStaticMarkup(
		<SubagentDialog run={RUN} isRunning={isRunning} onClose={() => undefined} />,
	);

describe('SubagentDialog', () => {
	it('running → its lines as the stream shows them, its last words still a line, no report yet', () => {
		const html = render(true);

		expect(html).toContain('Explore');
		expect(html).toContain('running · ');
		expect(html).toContain('search for route');
		expect(html).toContain('no match');
		expect(html).toContain('<strong>src/router.ts</strong>');
		expect(html).not.toContain('aria-label="report"');
	});

	it('done → its last words under "report", not again among the lines', () => {
		const html = render(false);

		expect(html).toContain('· done');
		expect(html).toContain('aria-label="report"');
		expect(html.split('src/router.ts').length - 1).toBe(1);
	});
});

describe('what opens a transcript', () => {
	it("an Agent call's row with a kept transcript is a button; without one it is a line", () => {
		const item = {
			id: 'i',
			at: 1,
			kind: 'tool',
			name: 'Agent',
			summary: 'start a subagent: Find the router',
		} as const;

		expect(renderToStaticMarkup(<StreamLine item={item} onOpen={() => undefined} />)).toContain(
			'<button type="button" class="line tool opens">',
		);
		expect(renderToStaticMarkup(<StreamLine item={item} />)).toContain('<div class="line tool">');
	});

	const SUBAGENT = {
		taskId: 't1',
		agentType: 'Explore',
		description: 'd',
		startedAt: 0,
		step: null,
		isBackground: false,
	};

	it("a running sub-agent's card is a button in Voice OS; in Set up's chat (no onOpen) a plain card", () => {
		const opens = renderToStaticMarkup(
			<SubagentsPanel subagents={[SUBAGENT]} onOpen={() => undefined} />,
		);
		const plain = renderToStaticMarkup(<SubagentsPanel subagents={[SUBAGENT]} />);

		expect(opens).toContain('<button type="button" class="subagent" data-task="t1">');
		expect(plain).toContain('<div class="subagent" data-task="t1">');
		expect(plain).not.toContain('<button');
	});

	describe('SessionStream', () => {
		const tool = (id: string, summary: string) =>
			({ id, at: 1, kind: 'tool', name: 'Agent', summary }) as const;
		const session = {
			...createSession({ ref: 'r', label: 'r', branch: '', cwd: '/w', dirs: [], isPinned: false }),
			stream: [tool('kept', 'start a subagent: kept'), tool('gone', 'start a subagent: gone')],
		};
		const countButtons = (html: string) => html.split('<button').length - 1;

		it("no openFor (Set up's chat) → every row a line, even with something drawn under it", () => {
			const html = renderToStaticMarkup(
				<SessionStream
					sessionRef="r"
					session={session}
					className="stream"
					renderAfter={() => <span>recorded</span>}
				/>,
			);

			expect(countButtons(html)).toBe(0);
		});

		it('openFor → only the rows it opens are buttons', () => {
			const html = renderToStaticMarkup(
				<SessionStream
					sessionRef="r"
					session={session}
					className="stream"
					openFor={(item) => (item.id === 'kept' ? () => undefined : null)}
				/>,
			);

			expect(countButtons(html)).toBe(1);
			expect(html).toContain('start a subagent: kept <span class="opens-hint">');
		});
	});
});
