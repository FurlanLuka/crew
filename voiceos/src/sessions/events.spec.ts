import { describe, expect, it } from 'bun:test';
import { mapMessage, summarizeTool, type MapContext } from './events.js';

const createMapContext = (): MapContext => ({
	ref: 'store/main',
	toolSummaries: new Map(),
	limits: { fiveHour: null, sevenDay: null, resetsAt: null },
});

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

	it('subagent traffic → dropped', () => {
		expect(
			mapMessage(
				{
					type: 'assistant',
					parent_tool_use_id: 'x',
					message: { content: [{ type: 'text', text: 'inner' }] },
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
