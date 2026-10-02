import type { Observation } from '../shared/protocol.js';
import type { MapContext, RawMessage } from './events.js';
import {
	clipText,
	getContentBlocks,
	readString,
	summarizeResult,
	summarizeTool,
} from './tool-summary.js';

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

const mapSubagentResults = (message: RawMessage, ref: string, taskId: string): Observation[] =>
	getContentBlocks(message)
		.filter((block) => block.type === 'tool_result')
		.map((block) => ({
			type: 'subagent_item',
			ref,
			taskId,
			item: { kind: 'tool_result', ...summarizeResult(block) },
		}));

// A sub-agent's own traffic: its transcript on the page (text, calls, results) and the latest step
// on its row in the sub-agents panel. Its thinking is not shown, as the session's is not.
export const mapSubagentMessage = (
	message: RawMessage,
	mapContext: MapContext,
	cwd?: string,
): Observation[] => {
	const taskId = mapContext.subagentTasks.get(readString(message.parent_tool_use_id));
	const { ref } = mapContext;

	if (message.type === 'user') {
		return taskId ? mapSubagentResults(message, ref, taskId) : [];
	}

	if (message.type !== 'assistant') {
		return [];
	}

	const items: Observation[] = [];
	let lastStep: string | undefined;

	for (const block of getContentBlocks(message)) {
		if (block.type === 'text' && readString(block.text).trim() && taskId) {
			items.push({
				type: 'subagent_item',
				ref,
				taskId,
				item: { kind: 'text', text: readString(block.text) },
			});
		}

		if (block.type === 'tool_use') {
			const id = readString(block.id);
			const name = readString(block.name);
			const step = summarizeTool(name, (block.input ?? {}) as Record<string, unknown>, cwd);

			// A sub-agent's call can be denied too, and the denial only carries its id: without
			// the summary the blocked strip could not say what was refused. Kept even when the
			// sub-agent has no row (its task_started was skipped).
			mapContext.toolSummaries.set(id, step);
			lastStep = step;

			if (taskId) {
				items.push({
					type: 'subagent_item',
					ref,
					taskId,
					item: { kind: 'tool', name, summary: step },
				});
			}
		}
	}

	if (!taskId) {
		return [];
	}

	if (!lastStep) {
		return items;
	}

	mapContext.subagentsWithSteps.add(taskId);

	return [...items, { type: 'subagent_step', ref, taskId, step: lastStep }];
};

const endSubagent = (mapContext: MapContext, taskId: string): Observation[] => {
	for (const [toolUseId, knownTaskId] of mapContext.subagentTasks) {
		if (knownTaskId === taskId) {
			mapContext.subagentTasks.delete(toolUseId);
		}
	}

	mapContext.subagentsWithSteps.delete(taskId);

	return [{ type: 'subagent_ended', ref: mapContext.ref, taskId }];
};

export const mapTaskMessage = (message: RawMessage, mapContext: MapContext): Observation[] => {
	const { ref } = mapContext;
	const taskId = readString(message.task_id);

	if (!taskId) {
		return [];
	}

	switch (message.subtype) {
		case 'task_started': {
			// Background shells and housekeeping tasks send these too; only agents get a row.
			if (message.task_type !== 'local_agent' || message.ambient || message.skip_transcript) {
				return [];
			}

			mapContext.subagentTasks.set(readString(message.tool_use_id), taskId);

			return [
				{
					type: 'subagent_started',
					ref,
					taskId,
					agentType: message.subagent_type ?? null,
					description: clipText(readString(message.description), 120),
					isBackground: message.is_backgrounded === true,
					toolUseId: readString(message.tool_use_id),
				},
			];
		}

		case 'task_progress': {
			const toolName = readString(message.last_tool_name);

			if (!toolName || mapContext.subagentsWithSteps.has(taskId)) {
				return [];
			}

			return [{ type: 'subagent_step', ref, taskId, step: `use ${toolName}` }];
		}

		case 'task_updated': {
			if (message.patch?.status && TERMINAL_TASK_STATUSES.has(message.patch.status)) {
				return endSubagent(mapContext, taskId);
			}

			return message.patch?.is_backgrounded ? [{ type: 'subagent_backgrounded', ref, taskId }] : [];
		}

		case 'task_notification':
			return endSubagent(mapContext, taskId);

		default:
			return [];
	}
};
