import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SubagentRun } from '../../shared/protocol.js';
import { SubagentDialog } from './SubagentDialog.js';
import { SubagentsPanel } from './SubagentsPanel.js';
import { StreamLine } from './StreamLine.js';

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

	it("a running sub-agent's card is a button", () => {
		const html = renderToStaticMarkup(
			<SubagentsPanel
				subagents={[
					{
						taskId: 't1',
						agentType: 'Explore',
						description: 'd',
						startedAt: 0,
						step: null,
						isBackground: false,
					},
				]}
				onOpen={() => undefined}
			/>,
		);

		expect(html).toContain('<button type="button" class="subagent" data-task="t1">');
	});
});
