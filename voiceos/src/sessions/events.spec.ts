import { describe, expect, it } from 'bun:test';
import {
	createMapContext as createContextFor,
	describeCompaction,
	mapMessage,
	readDenial,
	type RawMessage,
} from './events.js';
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
			{ type: 'tool', ref: 'store/main', name: 'Bash', summary: 'run npm test', toolUseId: 't1' },
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

	it('the safety check could not decide (no verdict) → a quiet notice, not a denial to allow', () => {
		const mapContext = createMapContext();
		mapContext.toolSummaries.set('t9', 'run git push');
		const transient = {
			type: 'system',
			subtype: 'permission_denied',
			tool_name: 'Bash',
			tool_use_id: 't9',
			decision_reason_type: 'classifier',
			message:
				'The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of Bash. This is a transient failure of the check, not a judgment about the action.',
		} as RawMessage;
		const refused = {
			...transient,
			message: 'Blocked: pushing to a shared branch without review.',
		} as RawMessage;

		expect(mapMessage(transient, mapContext)).toEqual([
			{
				type: 'session_notice',
				ref: 'store/main',
				text: 'Safety check unavailable for run git push; Claude can try again.',
			},
		]);
		expect(mapMessage(refused, mapContext)).toEqual([
			{ type: 'denied', ref: 'store/main', toolName: 'Bash', summary: 'run git push' },
		]);
		expect(
			readDenial(
				{
					...refused,
					decision_reason_type: 'other',
					decision_reason_code: 'outside_reads_blocked',
				},
				mapContext.toolSummaries,
			),
		).toEqual({
			toolName: 'Bash',
			summary: 'run git push',
			isTransient: false,
			reasonType: 'other',
			reasonCode: 'outside_reads_blocked',
		});
		expect(readDenial(transient, mapContext.toolSummaries)).toEqual({
			toolName: 'Bash',
			summary: 'run git push',
			isTransient: true,
			reasonType: 'classifier',
			reasonCode: null,
		});
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
				toolUseId: 'toolu_agent',
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

	it('its text and calls → its transcript, the last call its step; no parent tool line, each summary kept', () => {
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
			{ type: 'subagent_item', ref, taskId: 'task1', item: { kind: 'text', text: 'Looking.' } },
			{
				type: 'subagent_item',
				ref,
				taskId: 'task1',
				item: { kind: 'tool', name: 'Grep', summary: 'search for route' },
			},
			{
				type: 'subagent_item',
				ref,
				taskId: 'task1',
				item: { kind: 'tool', name: 'Read', summary: 'read src/router.ts' },
			},
			{ type: 'subagent_step', ref, taskId: 'task1', step: 'read src/router.ts' },
		]);
		expect([...mapContext.toolSummaries]).toEqual([
			['a', 'search for route'],
			['b', 'read src/router.ts'],
		]);
	});

	it('its Bash call is denied → the denial says what it ran', () => {
		const mapContext = startedContext();

		mapMessage(
			{
				type: 'assistant',
				parent_tool_use_id: 'toolu_agent',
				message: {
					content: [{ type: 'tool_use', id: 't7', name: 'Bash', input: { command: 'git push' } }],
				},
			},
			mapContext,
		);

		expect(
			mapMessage(
				{
					type: 'system',
					subtype: 'permission_denied',
					tool_name: 'Bash',
					tool_use_id: 't7',
					agent_id: 'a1',
				} as RawMessage,
				mapContext,
			),
		).toEqual([{ type: 'denied', ref, toolName: 'Bash', summary: 'run git push' }]);
	});

	it('a sub-agent with no row (its task_started skipped) → no step, but its denial still says what it ran', () => {
		const mapContext = createMapContext();

		const step = mapMessage(
			{
				type: 'assistant',
				parent_tool_use_id: 'toolu_agent',
				message: {
					content: [{ type: 'tool_use', id: 't7', name: 'Bash', input: { command: 'git push' } }],
				},
			},
			mapContext,
		);

		expect(step).toEqual([]);
		expect(
			mapMessage(
				{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't7' },
				mapContext,
			),
		).toEqual([{ type: 'denied', ref, toolName: 'Bash', summary: 'run git push' }]);
	});

	it('a denial of a call never seen → a neutral "a Bash call", not "run "', () =>
		expect(
			mapMessage(
				{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'nope' },
				createMapContext(),
			),
		).toEqual([{ type: 'denied', ref, toolName: 'Bash', summary: 'a Bash call' }]));

	it("its results → transcript lines like the main stream's; its thinking and stream deltas → nothing", () => {
		const mapContext = startedContext();
		const said = (message: RawMessage) => mapMessage(message, mapContext);

		expect(
			said({
				type: 'user',
				parent_tool_use_id: 'toolu_agent',
				message: {
					content: [
						{ type: 'tool_result', content: `${'x'.repeat(200)}\nmore` },
						{ type: 'tool_result', content: '', is_error: true },
					],
				},
			}),
		).toEqual([
			{
				type: 'subagent_item',
				ref,
				taskId: 'task1',
				item: { kind: 'tool_result', ok: true, summary: `${'x'.repeat(159)}…` },
			},
			{
				type: 'subagent_item',
				ref,
				taskId: 'task1',
				item: { kind: 'tool_result', ok: false, summary: 'failed' },
			},
		]);
		expect(
			said({
				type: 'assistant',
				parent_tool_use_id: 'toolu_agent',
				message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
			}),
		).toEqual([]);
		expect(
			said({
				type: 'stream_event',
				parent_tool_use_id: 'toolu_agent',
				event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
			}),
		).toEqual([]);
	});

	it('the traffic of a sub-agent with no row → no transcript', () =>
		expect(
			mapMessage(
				{
					type: 'assistant',
					parent_tool_use_id: 'toolu_agent',
					message: { content: [{ type: 'text', text: 'inner' }] },
				},
				createMapContext(),
			),
		).toEqual([]));

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

		// Its text alone is a transcript line, not a step: progress still names its tool.
		expect(
			mapMessage(
				{
					type: 'assistant',
					parent_tool_use_id: 'toolu_agent',
					message: { content: [{ type: 'text', text: 'Looking.' }] },
				},
				mapContext,
			),
		).toEqual([
			{ type: 'subagent_item', ref, taskId: 'task1', item: { kind: 'text', text: 'Looking.' } },
		]);
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
		).toEqual([
			{
				type: 'tool',
				ref,
				name: 'Agent',
				summary: 'start a subagent: Find the router',
				// The row that opens its transcript on the page.
				toolUseId: 'toolu_agent',
			},
		]);
	});
});

describe('slash commands', () => {
	it('/clear → a conversation reset', () =>
		expect(mapMessage({ type: 'conversation_reset' }, createMapContext())).toEqual([
			{ type: 'conversation_reset', ref: 'store/main' },
		]));

	it('/compact → compaction over, and a notice; the sizes when the SDK gives them', () => {
		expect(mapMessage({ type: 'system', subtype: 'compact_boundary' }, createMapContext())).toEqual(
			[
				{ type: 'compacting', ref: 'store/main', isCompacting: false },
				{ type: 'session_notice', ref: 'store/main', text: 'Context compacted.' },
			],
		);
		expect(describeCompaction({ pre_tokens: 181_400, post_tokens: 22_300 })).toBe(
			'Context compacted: 181k → 22k tokens.',
		);
		expect(describeCompaction({ pre_tokens: 181_400 })).toBe(
			'Context compacted: 181k tokens before.',
		);
		expect(describeCompaction({ pre_tokens: 900, post_tokens: 400 })).toBe(
			'Context compacted: 900 → 400 tokens.',
		);
	});

	it("status 'compacting' → compacting; null → over; failed → over and a notice; 'requesting' → nothing", () => {
		const status = (fields: Record<string, unknown>) =>
			mapMessage({ type: 'system', subtype: 'status', ...fields }, createMapContext());

		expect(status({ status: 'compacting' })).toEqual([
			{ type: 'compacting', ref: 'store/main', isCompacting: true },
		]);
		expect(status({ status: null, compact_result: 'success' })).toEqual([
			{ type: 'compacting', ref: 'store/main', isCompacting: false },
		]);
		expect(
			status({ status: null, compact_result: 'failed', compact_error: 'prompt too long' }),
		).toEqual([
			{ type: 'compacting', ref: 'store/main', isCompacting: false },
			{ type: 'session_notice', ref: 'store/main', text: 'Compaction failed: prompt too long' },
		]);
		expect(status({ status: 'requesting' })).toEqual([]);
		expect(status({})).toEqual([]);
	});

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

describe('mapMessage: what a session shows', () => {
	const createShowing = () => {
		const saved: string[] = [];
		const shown: string[] = [];
		const context = createContextFor('store/main', {
			// Only paths under shots/ are images inside the worktree here.
			showImage: (path) => {
				shown.push(path);

				return path.startsWith('shots/') ? `${path.length}.png` : null;
			},
			saveImage: (data, mediaType) => {
				saved.push(`${mediaType}:${data}`);

				return 'tool.png';
			},
		});

		return { context, saved, shown };
	};

	const toolCall = (context: ReturnType<typeof createContextFor>, id: string, name: string) =>
		mapMessage(
			{ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } },
			context,
		);

	const toolResult = (id: string, content: unknown, isError = false) => ({
		type: 'user' as const,
		message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
	});

	const screenshot = [
		{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
	];
	const typesOf = (observations: { type: string }[]) =>
		observations.map((observation) => observation.type);

	it('an image named in the reply → its stored name; one the hook refuses → nothing', () => {
		const { context, shown } = createShowing();

		const observations = mapMessage(
			{
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: 'Here: ![login](shots/login.png) and /etc/x/y.png' }],
				},
			},
			context,
		);

		expect(shown).toEqual(['shots/login.png', '/etc/x/y.png']);
		expect(observations.filter((observation) => observation.type === 'image')).toEqual([
			{ type: 'image', ref: 'store/main', name: '15.png', alt: 'login' },
		]);
	});

	it("a tool's screenshot → stored and shown", () => {
		const { context, saved } = createShowing();
		toolCall(context, 't1', 'mcp__playwright__browser_take_screenshot');

		const observations = mapMessage(toolResult('t1', screenshot), context);

		expect(saved).toEqual(['image/png:iVBOR']);
		expect(observations).toContainEqual({
			type: 'image',
			ref: 'store/main',
			name: 'tool.png',
			alt: '',
		});
	});

	it('an image the session only read, or from a failed call → not shown, nothing stored', () => {
		const { context, saved } = createShowing();
		toolCall(context, 't2', 'Read');
		toolCall(context, 't3', 'mcp__playwright__browser_take_screenshot');

		const read = mapMessage(toolResult('t2', screenshot), context);
		const failed = mapMessage(toolResult('t3', screenshot, true), context);

		expect(saved).toEqual([]);
		expect(typesOf([...read, ...failed])).not.toContain('image');
	});

	it('a doc linked in the reply, or returned by a connector → a doc', () => {
		const { context } = createShowing();
		toolCall(context, 't4', 'mcp__claude_ai_Claude_Docs__batch');

		const fromText = mapMessage(
			{
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: 'Plan: [Retry plan](https://claude.ai/artifact/a1)' }],
				},
			},
			context,
		);
		const fromConnector = mapMessage(
			toolResult('t4', 'Created https://claude.ai/code/artifact/a2'),
			context,
		);

		expect(fromText).toContainEqual({
			type: 'doc',
			ref: 'store/main',
			url: 'https://claude.ai/artifact/a1',
			title: 'Retry plan',
		});
		expect(fromConnector).toContainEqual({
			type: 'doc',
			ref: 'store/main',
			url: 'https://claude.ai/code/artifact/a2',
			title: 'Claude artifact',
		});
	});

	it("Claude Code's Artifact tool → its link is a doc; a comment thread's link is not", () => {
		const { context } = createShowing();
		toolCall(context, 't7', 'Artifact');
		toolCall(context, 't8', 'ArtifactComments');

		const made = mapMessage(
			toolResult('t7', 'Created https://claude.ai/code/artifact/a3'),
			context,
		);
		const thread = mapMessage(
			toolResult('t8', 'Replied on https://claude.ai/code/artifact/a3'),
			context,
		);

		expect(made).toContainEqual({
			type: 'doc',
			ref: 'store/main',
			url: 'https://claude.ai/code/artifact/a3',
			title: 'Claude artifact',
		});
		expect(typesOf(thread)).not.toContain('doc');
	});

	it("a doc link inside a file read or a command output is not the session's doc", () => {
		const { context } = createShowing();
		toolCall(context, 't5', 'Read');
		toolCall(context, 't6', 'Bash');

		const read = mapMessage(
			toolResult('t5', 'See https://docs.google.com/document/d/x/edit'),
			context,
		);
		const bash = mapMessage(toolResult('t6', 'https://claude.ai/artifact/from-readme'), context);

		expect(typesOf([...read, ...bash])).not.toContain('doc');
	});

	it('without media hooks (a bare map) → docs still found, no images', () => {
		const observations = mapMessage(
			{
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: '![x](shots/a.png) https://claude.ai/artifact/z' }],
				},
			},
			createMapContext(),
		);

		expect(typesOf(observations)).toEqual(['assistant_text', 'doc']);
	});
});
