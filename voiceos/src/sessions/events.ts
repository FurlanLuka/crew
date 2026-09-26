import type { Limits, Observation } from '../shared/protocol.js';
import { mapSubagentMessage, mapTaskMessage } from './subagent-events.js';
import { clipText, getContentBlocks, readString, summarizeTool } from './tool-summary.js';

export interface RawMessage {
	// Only the fields read here are typed, so a CLI update that adds fields never breaks the mapping.
	type: string;
	subtype?: string;
	parent_tool_use_id?: string | null;
	event?: { type?: string; delta?: { type?: string; text?: string } };
	message?: { content?: unknown };
	tool_use_result?: unknown;
	tool_name?: string;
	tool_use_id?: string;
	uuid?: string;
	result?: string;
	// Task events (sub-agents): system subtypes task_started, task_progress, task_updated, task_notification.
	task_id?: string;
	task_type?: string;
	subagent_type?: string;
	description?: string;
	is_backgrounded?: boolean;
	ambient?: boolean;
	skip_transcript?: boolean;
	last_tool_name?: string;
	patch?: { status?: string; is_backgrounded?: boolean };
	content?: string;
	total_cost_usd?: number;
	is_error?: boolean;
	rate_limit_info?: { rateLimitType?: string; utilization?: number; resetsAt?: number };
}

export interface MapContext {
	ref: string;
	toolSummaries: Map<string, string>;
	limits: Limits;
	// The tool call that started each running sub-agent → its task id, so its own calls find it.
	subagentTasks: Map<string, string>;
	// Sub-agents that already reported a tool step: a later progress tick must not overwrite it.
	subagentsWithSteps: Set<string>;
}

export const createMapContext = (ref: string): MapContext => ({
	ref,
	toolSummaries: new Map(),
	limits: { fiveHour: null, sevenDay: null, resetsAt: null },
	subagentTasks: new Map(),
	subagentsWithSteps: new Set(),
});

interface ToolResultWithPatch {
	filePath?: unknown;
	structuredPatch?: unknown;
}

const extractResultText = (content: unknown): string => {
	if (typeof content === 'string') {
		return content;
	}

	if (!Array.isArray(content)) {
		return '';
	}

	return content.map((part) => readString((part as Record<string, unknown>).text)).join(' ');
};

const buildDiffObservation = (ref: string, toolResult: unknown): Observation | null => {
	if (!toolResult || typeof toolResult !== 'object') {
		return null;
	}

	const result = toolResult as ToolResultWithPatch;

	if (!Array.isArray(result.structuredPatch) || result.structuredPatch.length === 0) {
		return null;
	}

	const lines: string[] = [];

	for (const hunk of result.structuredPatch as Record<string, unknown>[]) {
		lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);

		if (Array.isArray(hunk.lines)) {
			lines.push(...(hunk.lines as string[]));
		}
	}

	return { type: 'diff', ref, filePath: readString(result.filePath), lines: lines.slice(0, 200) };
};

const mergeLimits = (
	info: NonNullable<RawMessage['rate_limit_info']>,
	previous: Limits,
): Limits => {
	const percent = typeof info.utilization === 'number' ? Math.round(info.utilization * 100) : null;
	const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : previous.resetsAt;

	if (info.rateLimitType === 'five_hour') {
		return { ...previous, fiveHour: percent };
	}

	if (info.rateLimitType?.startsWith('seven_day')) {
		return { ...previous, sevenDay: percent, resetsAt };
	}

	return previous;
};

const mapSystemMessage = (message: RawMessage, mapContext: MapContext): Observation[] => {
	const { ref } = mapContext;

	switch (message.subtype) {
		case 'task_started':
		case 'task_progress':
		case 'task_updated':
		case 'task_notification':
			return mapTaskMessage(message, mapContext);

		case 'compact_boundary':
			return [{ type: 'session_notice', ref, text: 'Context compacted.' }];

		case 'local_command_output': {
			const text = clipText(readString(message.content), 300);

			return text ? [{ type: 'session_notice', ref, text }] : [];
		}

		case 'permission_denied': {
			const toolName = readString(message.tool_name);
			const summary =
				mapContext.toolSummaries.get(readString(message.tool_use_id)) ??
				summarizeTool(toolName, {});

			return [{ type: 'denied', ref, toolName, summary }];
		}

		default:
			return [];
	}
};

export const mapMessage = (
	message: RawMessage,
	mapContext: MapContext,
	cwd?: string,
): Observation[] => {
	const { ref } = mapContext;

	// A sub-agent's own traffic only feeds its row in the sub-agents panel.
	if (message.parent_tool_use_id) {
		return mapSubagentMessage(message, mapContext, cwd);
	}

	switch (message.type) {
		case 'stream_event': {
			const delta = message.event?.delta;

			if (
				message.event?.type === 'content_block_delta' &&
				delta?.type === 'text_delta' &&
				delta.text
			) {
				return [{ type: 'text_delta', ref, text: delta.text }];
			}

			return [];
		}

		case 'assistant': {
			const observations: Observation[] = [];

			for (const block of getContentBlocks(message)) {
				if (block.type === 'text' && readString(block.text).trim()) {
					observations.push({ type: 'assistant_text', ref, text: readString(block.text) });
				}

				if (block.type === 'tool_use') {
					const name = readString(block.name);
					const summary = summarizeTool(name, (block.input ?? {}) as Record<string, unknown>, cwd);

					mapContext.toolSummaries.set(readString(block.id), summary);
					observations.push({ type: 'tool', ref, name, summary });
				}
			}

			return observations;
		}

		case 'user': {
			const observations: Observation[] = [];

			for (const block of getContentBlocks(message)) {
				if (block.type !== 'tool_result') {
					continue;
				}

				const isOk = block.is_error !== true;
				const text = extractResultText(block.content);

				observations.push({
					type: 'tool_result',
					ref,
					ok: isOk,
					summary: clipText(text.split('\n')[0] ?? '', 160) || (isOk ? 'done' : 'failed'),
				});
			}

			const diff = buildDiffObservation(ref, message.tool_use_result);

			if (diff) {
				observations.push(diff);
			}

			return observations;
		}

		case 'result':
			return [
				{
					type: 'turn_ended',
					ref,
					costUsd: message.total_cost_usd ?? 0,
					text: readString(message.result),
				},
			];

		case 'rate_limit_event': {
			if (!message.rate_limit_info) {
				return [];
			}

			mapContext.limits = mergeLimits(message.rate_limit_info, mapContext.limits);

			return [{ type: 'limits', limits: mapContext.limits }];
		}

		case 'system':
			return mapSystemMessage(message, mapContext);

		case 'conversation_reset':
			return [{ type: 'conversation_reset', ref }];

		default:
			return [];
	}
};
