import type { Observation } from '../shared/protocol.js';
import type { MapContext, RawMessage } from './events.js';
import { clipText, getContentBlocks, readString, summarizeTool } from './tool-summary.js';

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

export const mapSubagentMessage = (
	message: RawMessage,
	mapContext: MapContext,
	cwd?: string,
): Observation[] => {
	const taskId = mapContext.subagentTasks.get(readString(message.parent_tool_use_id));

	if (message.type !== 'assistant' || !taskId) {
		return [];
	}

	const lastToolUse = getContentBlocks(message)
		.filter((block) => block.type === 'tool_use')
		.at(-1);

	if (!lastToolUse) {
		return [];
	}

	mapContext.subagentsWithSteps.add(taskId);

	const step = summarizeTool(
		readString(lastToolUse.name),
		(lastToolUse.input ?? {}) as Record<string, unknown>,
		cwd,
	);

	return [{ type: 'subagent_step', ref: mapContext.ref, taskId, step }];
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
