import { findDocLinks } from './doc-links.js';
import { findShownImages } from './media.js';
import type { Limits, Observation } from '../shared/protocol.js';
import { mapSubagentMessage, mapTaskMessage } from './subagent-events.js';
import {
	clipText,
	extractResultText,
	getContentBlocks,
	readString,
	summarizeResult,
	summarizeTool,
} from './tool-summary.js';

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
	// system/status: 'compacting' while the context is compacted, null when that ends.
	status?: string | null;
	compact_result?: string;
	compact_error?: string;
	compact_metadata?: { pre_tokens?: number; post_tokens?: number };
	// system/permission_denied: why auto mode refused a tool call.
	decision_reason_type?: string;
	decision_reason_code?: string;
}

export interface Denial {
	toolName: string;
	summary: string;
	// The safety check could not decide (it was unavailable): no judgment was made about the call.
	isTransient: boolean;
	reasonType: string | null;
	reasonCode: string | null;
}

// The CLI sends no reason code when its classifier is unavailable, only this wording in the message.
const TRANSIENT_DENIAL_PATTERN = /gave no verdict/i;

export const readDenial = (message: RawMessage, toolSummaries: Map<string, string>): Denial => {
	const toolName = readString(message.tool_name);

	return {
		toolName,
		// An unknown call gets a neutral phrase: `summarizeTool(name, {})` would say "run " for Bash.
		summary: toolSummaries.get(readString(message.tool_use_id)) ?? `a ${toolName} call`,
		// Here `message` is the rejection text, not an assistant message.
		isTransient: TRANSIENT_DENIAL_PATTERN.test(
			readString((message as { message?: unknown }).message),
		),
		reasonType: readString(message.decision_reason_type) || null,
		reasonCode: readString(message.decision_reason_code) || null,
	};
};

const formatTokens = (tokens: number): string =>
	tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);

export const describeCompaction = (metadata: RawMessage['compact_metadata']): string => {
	// The SDK may leave out the size after, and older ones send no sizes at all.
	const before = metadata?.pre_tokens;
	const after = metadata?.post_tokens;

	if (typeof before !== 'number') {
		return 'Context compacted.';
	}

	return typeof after === 'number'
		? `Context compacted: ${formatTokens(before)} → ${formatTokens(after)} tokens.`
		: `Context compacted: ${formatTokens(before)} tokens before.`;
};

const mapStatusMessage = (message: RawMessage, ref: string): Observation[] => {
	// 'requesting' and anything newer say nothing about compaction.
	if (message.status === 'compacting') {
		return [{ type: 'compacting', ref, isCompacting: true }];
	}

	if (message.status !== null) {
		return [];
	}

	const ended: Observation = { type: 'compacting', ref, isCompacting: false };

	return message.compact_result === 'failed'
		? [
				ended,
				{
					type: 'session_notice',
					ref,
					text: `Compaction failed${message.compact_error ? `: ${clipText(message.compact_error, 200)}` : '.'}`,
				},
			]
		: [ended];
};

export interface MapContext {
	ref: string;
	toolSummaries: Map<string, string>;
	limits: Limits;
	// The tool call that started each running sub-agent → its task id, so its own calls find it.
	subagentTasks: Map<string, string>;
	// Sub-agents that already reported a tool step: a later progress tick must not overwrite it.
	subagentsWithSteps: Set<string>;
	// Each tool call's name, so a result knows which tool made it (an image Read is not shown).
	toolNames: Map<string, string>;
	// Disk access for what a session shows; absent (tests, a bare map) nothing is shown.
	media?: MediaHooks;
}

export interface MediaHooks {
	// A path the session named: stored when it is an image inside its worktree; its media name.
	showImage: (path: string) => string | null;
	// A tool's image, stored; its media name.
	saveImage: (data: string, mediaType: string) => string | null;
}

export const createMapContext = (ref: string, media?: MediaHooks): MapContext => ({
	ref,
	toolNames: new Map(),
	...(media ? { media } : {}),
	toolSummaries: new Map(),
	limits: { fiveHour: null, sevenDay: null, resetsAt: null },
	subagentTasks: new Map(),
	subagentsWithSteps: new Set(),
});

interface ToolResultWithPatch {
	filePath?: unknown;
	structuredPatch?: unknown;
}

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

		case 'status':
			return mapStatusMessage(message, ref);

		case 'compact_boundary':
			return [
				{ type: 'compacting', ref, isCompacting: false },
				{ type: 'session_notice', ref, text: describeCompaction(message.compact_metadata) },
			];

		case 'local_command_output': {
			const text = clipText(readString(message.content), 300);

			return text ? [{ type: 'session_notice', ref, text }] : [];
		}

		case 'permission_denied': {
			const { toolName, summary, isTransient } = readDenial(message, mapContext.toolSummaries);

			// Not a refusal: nothing for the developer to allow, and Claude may simply try again.
			return isTransient
				? [
						{
							type: 'session_notice',
							ref,
							text: `Safety check unavailable for ${summary}; Claude can try again.`,
						},
					]
				: [{ type: 'denied', ref, toolName, summary }];
		}

		default:
			return [];
	}
};

const toDocObservations = (text: string, ref: string): Observation[] =>
	findDocLinks(text).map((link) => ({ type: 'doc', ref, url: link.url, title: link.title }));

const findShownMedia = (text: string, mapContext: MapContext): Observation[] => {
	const { ref, media } = mapContext;
	const images = media
		? findShownImages(text).flatMap((image): Observation[] => {
				const name = media.showImage(image.path);

				return name ? [{ type: 'image', ref, name, alt: image.alt }] : [];
			})
		: [];

	return [...images, ...toDocObservations(text, ref)];
};

const findToolImages = (content: unknown, mapContext: MapContext): Observation[] => {
	const { ref, media } = mapContext;

	if (!media || !Array.isArray(content)) {
		return [];
	}

	return content.flatMap((part): Observation[] => {
		const block = part as {
			type?: unknown;
			source?: { type?: unknown; data?: unknown; media_type?: unknown };
		};

		if (block.type !== 'image' || block.source?.type !== 'base64') {
			return [];
		}

		const name = media.saveImage(
			readString(block.source.data),
			readString(block.source.media_type),
		);

		return name ? [{ type: 'image', ref, name, alt: '' }] : [];
	});
};

export const mapMessage = (
	message: RawMessage,
	mapContext: MapContext,
	cwd?: string,
): Observation[] => {
	const { ref } = mapContext;

	// A sub-agent's own traffic feeds its row in the sub-agents panel and its transcript, never the stream.
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
					const text = readString(block.text);

					observations.push(
						{ type: 'assistant_text', ref, text },
						...findShownMedia(text, mapContext),
					);
				}

				if (block.type === 'tool_use') {
					const name = readString(block.name);
					const summary = summarizeTool(name, (block.input ?? {}) as Record<string, unknown>, cwd);

					mapContext.toolSummaries.set(readString(block.id), summary);
					mapContext.toolNames.set(readString(block.id), name);
					observations.push({ type: 'tool', ref, name, summary, toolUseId: readString(block.id) });
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

				const { ok: isOk, summary } = summarizeResult(block);

				observations.push({ type: 'tool_result', ref, ok: isOk, summary });

				const toolName = mapContext.toolNames.get(readString(block.tool_use_id)) ?? '';

				// A screenshot or chart a tool made is shown; an image the session only read is not.
				if (isOk && toolName !== 'Read') {
					observations.push(...findToolImages(block.content, mapContext));
				}

				// Docs come back from the tools that make them: the connectors (Claude Docs, Drive, Notion —
				// MCP tools) and Claude Code's own Artifact tool (not ArtifactComments: a comment thread is
				// no doc). A link a grep, a README or a web page happens to contain is not the session's doc.
				if (isOk && (toolName.startsWith('mcp__') || toolName === 'Artifact')) {
					observations.push(...toDocObservations(extractResultText(block.content), ref));
				}
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
