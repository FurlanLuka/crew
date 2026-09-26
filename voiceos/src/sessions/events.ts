import type { Limits, Observation } from '../shared/protocol.js';

const MAX_SUMMARY_CHARS = 140;

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
	result?: string;
	total_cost_usd?: number;
	is_error?: boolean;
	rate_limit_info?: { rateLimitType?: string; utilization?: number; resetsAt?: number };
}

export interface MapContext {
	ref: string;
	toolSummaries: Map<string, string>;
	limits: Limits;
}

interface ToolResultWithPatch {
	filePath?: unknown;
	structuredPatch?: unknown;
}

const clipText = (text: string, limit = MAX_SUMMARY_CHARS): string => {
	const flat = text.replace(/\s+/g, ' ').trim();

	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

const readString = (value: unknown): string => {
	return typeof value === 'string' ? value : '';
};

const shortenPath = (path: string, cwd?: string): string => {
	if (cwd && path.startsWith(`${cwd}/`)) {
		return path.slice(cwd.length + 1);
	}

	const parts = path.split('/');

	return parts.length > 3 ? parts.slice(-3).join('/') : path;
};

export const summarizeTool = (
	name: string,
	input: Record<string, unknown>,
	cwd?: string,
): string => {
	switch (name) {
		case 'Bash':
			return `run ${clipText(readString(input.command))}`;
		case 'Read':
			return `read ${shortenPath(readString(input.file_path), cwd)}`;
		case 'Edit':
		case 'MultiEdit':
			return `edit ${shortenPath(readString(input.file_path), cwd)}`;
		case 'Write':
			return `write ${shortenPath(readString(input.file_path), cwd)}`;
		case 'NotebookEdit':
			return `edit notebook ${shortenPath(readString(input.notebook_path), cwd)}`;
		case 'Grep':
			return `search for ${clipText(readString(input.pattern), 60)}`;
		case 'Glob':
			return `find files matching ${clipText(readString(input.pattern), 60)}`;
		case 'WebFetch':
			return `fetch ${clipText(readString(input.url), 80)}`;
		case 'WebSearch':
			return `search the web for ${clipText(readString(input.query), 60)}`;
		case 'Agent':
		case 'Task':
			return `start a subagent: ${clipText(readString(input.description), 80)}`;
		case 'ExitPlanMode':
			return 'present its plan';
		case 'AskUserQuestion':
			return 'ask you a question';
		default:
			return name.startsWith('mcp__')
				? `use ${name.split('__').slice(1).join(' ')}`
				: `use ${name}`;
	}
};

const getContentBlocks = (message: RawMessage): Record<string, unknown>[] => {
	const content = message.message?.content;

	return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
};

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

export const mapMessage = (
	message: RawMessage,
	mapContext: MapContext,
	cwd?: string,
): Observation[] => {
	const { ref } = mapContext;

	// Subagent traffic is dropped: a subagent shows as its single "start a subagent" line.
	if (message.parent_tool_use_id) {
		return [];
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

		case 'system': {
			if (message.subtype !== 'permission_denied') {
				return [];
			}

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
