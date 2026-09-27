import { describe, expect, it } from 'bun:test';
import { createMapContext as createContextFor, mapMessage } from './events.js';
import { summarizeTool } from './tool-summary.js';

const createMapContext = () => createContextFor('store/main');

describe('summarizeTool', () => {
	it('Bash → run + command', () =>
		expect(summarizeTool('Bash', { command: 'npm test' })).toBe('run npm test'));
	it('Edit inside cwd → relative path', () =>
		expect(summarizeTool('Edit', { file_path: '/w/store-api/src/a.ts' }, '/w/store-api')).toBe(
			'edit src/a.ts',
		));
	it('Edit outside cwd → last three segments', () =>
		expect(summarizeTool('Edit', { file_path: '/a/b/c/d/e.ts' })).toBe('edit c/d/e.ts'));
	it('long command → clipped with an ellipsis', () =>
		expect(summarizeTool('Bash', { command: 'x'.repeat(300) }).length).toBeLessThanOrEqual(144));
	it('MCP tool → server and tool name', () =>
		expect(summarizeTool('mcp__linear__save_issue', {})).toBe('use linear save_issue'));
	it('unknown tool → use <name>', () =>
		expect(summarizeTool('Frobnicate', {})).toBe('use Frobnicate'));
});

describe('mapMessage', () => {
	it('text delta → text_delta', () => {
		const observations = mapMessage(
			{
				type: 'stream_event',
				event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
			},
			createMapContext(),
		);
		expect(observations).toEqual([{ type: 'text_delta', ref: 'store/main', text: 'Hi' }]);
	});

	it('thinking delta → ignored', () => {
		expect(
			mapMessage(
				{
					type: 'stream_event',
					event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } },
				},
				createMapContext(),
			),
		).toEqual([]);
	});

	it('assistant text + tool_use → text then tool line; summary remembered by id', () => {
		const mapContext = createMapContext();
		const observations = mapMessage(
			{
				type: 'assistant',
				message: {
					content: [
						{ type: 'text', text: 'Running tests.' },
						{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
					],
				},
			},
			mapContext,
		);

		expect(observations).toEqual([
			{ type: 'assistant_text', ref: 'store/main', text: 'Running tests.' },
			{ type: 'tool', ref: 'store/main', name: 'Bash', summary: 'run npm test' },
		]);
		expect(mapContext.toolSummaries.get('t1')).toBe('run npm test');
	});

	it('traffic from an unknown sub-agent → dropped', () => {
		expect(
			mapMessage(
				{
					type: 'assistant',
					parent_tool_use_id: 'x',
					message: { content: [{ type: 'tool_use', id: 'i', name: 'Read', input: {} }] },
				},
				createMapContext(),
			),
		).toEqual([]);
	});

	it('tool result error → ok false with the first line', () => {
		const observations = mapMessage(
			{
				type: 'user',
				message: { content: [{ type: 'tool_result', is_error: true, content: 'Exit 1\nmore' }] },
			},
			createMapContext(),
		);
		expect(observations).toEqual([
			{ type: 'tool_result', ref: 'store/main', ok: false, summary: 'Exit 1' },
		]);
	});

	it('edit result with structuredPatch → diff lines with a hunk header', () => {
		const observations = mapMessage(
			{
				type: 'user',
				message: { content: [{ type: 'tool_result', content: 'ok' }] },
				tool_use_result: {
					filePath: '/w/a.ts',
					structuredPatch: [
						{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
					],
				},
			},
			createMapContext(),
		);
		expect(observations[1]).toEqual({
			type: 'diff',
			ref: 'store/main',
			filePath: '/w/a.ts',
			lines: ['@@ -1,1 +1,1 @@', '-a', '+b'],
		});
	});

	it('result → turn_ended with final text and cost', () => {
		expect(
			mapMessage(
				{ type: 'result', subtype: 'success', result: 'Done.', total_cost_usd: 0.03 },
				createMapContext(),
			),
		).toEqual([{ type: 'turn_ended', ref: 'store/main', costUsd: 0.03, text: 'Done.' }]);
	});

	it('permission_denied → denial with the summary of that tool call', () => {
		const mapContext = createMapContext();
		mapContext.toolSummaries.set('t9', 'run git push');
		expect(
			mapMessage(
				{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't9' },
				mapContext,
			),
		).toEqual([{ type: 'denied', ref: 'store/main', toolName: 'Bash', summary: 'run git push' }]);
	});

	it('rate limit events → percentages merged per window', () => {
		const mapContext = createMapContext();
		mapMessage(
			{
				type: 'rate_limit_event',
				rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.16 },
			},
			mapContext,
		);
		const observations = mapMessage(
			{
				type: 'rate_limit_event',
				rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.9, resetsAt: 99 },
			},
			mapContext,
		);
		expect(observations).toEqual([
			{ type: 'limits', limits: { fiveHour: 16, sevenDay: 90, resetsAt: 99 } },
		]);
	});

	it('init and hook messages → no observations', () => {
		expect(mapMessage({ type: 'system', subtype: 'init' }, createMapContext())).toEqual([]);
		expect(mapMessage({ type: 'system', subtype: 'hook_started' }, createMapContext())).toEqual([]);
	});
});

describe('sub-agents', () => {
	const ref = 'store/main';
	const taskStarted = (overrides: Record<string, unknown> = {}) => ({
		type: 'system',
		subtype: 'task_started',
		task_id: 'task1',
		tool_use_id: 'toolu_agent',
		task_type: 'local_agent',
		subagent_type: 'Explore',
		description: 'Find the router',
		...overrides,
	});

	const startedContext = () => {
		const mapContext = createMapContext();

		mapMessage(taskStarted(), mapContext);

		return mapContext;
	};

	it('an agent task starts → a row with its type and description', () => {
		expect(mapMessage(taskStarted({ is_backgrounded: true }), createMapContext())).toEqual([
			{
				type: 'subagent_started',
				ref,
				taskId: 'task1',
				agentType: 'Explore',
				description: 'Find the router',
				isBackground: true,
			},
		]);
	});

	it.each([
		['a background shell', { task_type: 'local_bash' }],
		['an ambient task', { ambient: true }],
		['a housekeeping task', { skip_transcript: true }],
	])('%s → no row', (_, overrides) =>
		expect(mapMessage(taskStarted(overrides), createMapContext())).toEqual([]),
	);

	it('its tool calls → the last one becomes its step; no parent tool line, no summary kept', () => {
		const mapContext = startedContext();
		const observations = mapMessage(
			{
				type: 'assistant',
				parent_tool_use_id: 'toolu_agent',
				message: {
					content: [
						{ type: 'text', text: 'Looking.' },
						{ type: 'tool_use', id: 'a', name: 'Grep', input: { pattern: 'route' } },
						{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/w/src/router.ts' } },
					],
				},
			},
			mapContext,
			'/w',
		);

		expect(observations).toEqual([
			{ type: 'subagent_step', ref, taskId: 'task1', step: 'read src/router.ts' },
		]);
		expect(mapContext.toolSummaries.size).toBe(0);
	});

	it('its text, results and stream deltas → dropped', () => {
		const mapContext = startedContext();

		for (const message of [
			{
				type: 'assistant',
				parent_tool_use_id: 'toolu_agent',
				message: { content: [{ type: 'text', text: 'inner' }] },
			},
			{
				type: 'user',
				parent_tool_use_id: 'toolu_agent',
				message: { content: [{ type: 'tool_result', content: 'x' }] },
			},
			{
				type: 'stream_event',
				parent_tool_use_id: 'toolu_agent',
				event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
			},
		]) {
			expect(mapMessage(message, mapContext)).toEqual([]);
		}
	});

	it('progress → its last tool as the step, only until a real step arrived', () => {
		const mapContext = startedContext();
		const progress = {
			type: 'system',
			subtype: 'task_progress',
			task_id: 'task1',
			last_tool_name: 'Bash',
		};

		expect(mapMessage(progress, mapContext)).toEqual([
			{ type: 'subagent_step', ref, taskId: 'task1', step: 'use Bash' },
		]);

		mapMessage(
			{
				type: 'assistant',
				parent_tool_use_id: 'toolu_agent',
				message: {
					content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }],
				},
			},
			mapContext,
		);

		expect(mapMessage(progress, mapContext)).toEqual([]);
	});

	it.each([
		[
			'a notification',
			{ type: 'system', subtype: 'task_notification', task_id: 'task1', status: 'completed' },
		],
		[
			'an update to killed',
			{ type: 'system', subtype: 'task_updated', task_id: 'task1', patch: { status: 'killed' } },
		],
	])('%s → ended, and its later traffic is dropped', (_, message) => {
		const mapContext = startedContext();

		expect(mapMessage(message, mapContext)).toEqual([
			{ type: 'subagent_ended', ref, taskId: 'task1' },
		]);
		expect(
			mapMessage(
				{
					type: 'assistant',
					parent_tool_use_id: 'toolu_agent',
					message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] },
				},
				mapContext,
			),
		).toEqual([]);
	});

	it('an update that is not an end → only a move to the background counts', () => {
		const mapContext = startedContext();

		expect(
			mapMessage(
				{ type: 'system', subtype: 'task_updated', task_id: 'task1', patch: { status: 'running' } },
				mapContext,
			),
		).toEqual([]);
		expect(
			mapMessage(
				{
					type: 'system',
					subtype: 'task_updated',
					task_id: 'task1',
					patch: { is_backgrounded: true },
				},
				mapContext,
			),
		).toEqual([{ type: 'subagent_backgrounded', ref, taskId: 'task1' }]);
	});

	it("the parent's Agent call → still its own start line", () => {
		expect(
			mapMessage(
				{
					type: 'assistant',
					message: {
						content: [
							{
								type: 'tool_use',
								id: 'toolu_agent',
								name: 'Agent',
								input: { description: 'Find the router' },
							},
						],
					},
				},
				createMapContext(),
			),
		).toEqual([{ type: 'tool', ref, name: 'Agent', summary: 'start a subagent: Find the router' }]);
	});
});

describe('slash commands', () => {
	it('/clear → a conversation reset', () =>
		expect(mapMessage({ type: 'conversation_reset' }, createMapContext())).toEqual([
			{ type: 'conversation_reset', ref: 'store/main' },
		]));

	it('/compact → a notice', () =>
		expect(mapMessage({ type: 'system', subtype: 'compact_boundary' }, createMapContext())).toEqual(
			[{ type: 'session_notice', ref: 'store/main', text: 'Context compacted.' }],
		));

	it('local command output → a notice with it; empty output → nothing', () => {
		expect(
			mapMessage(
				{ type: 'system', subtype: 'local_command_output', content: 'Usage: 12%' },
				createMapContext(),
			),
		).toEqual([{ type: 'session_notice', ref: 'store/main', text: 'Usage: 12%' }]);
		expect(
			mapMessage(
				{ type: 'system', subtype: 'local_command_output', content: ' ' },
				createMapContext(),
			),
		).toEqual([]);
	});
});
