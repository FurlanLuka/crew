import type { QueuedMessage, State } from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { type ToolResult, checkRef, fail, succeed } from './results.js';
import type { ToolContext } from './tools.js';

const log = createLogger('tools');

const PREVIEW_CHARS = 60;

export const QUEUED_ACTIONS = ['now', 'drop'] as const;
export type QueuedAction = (typeof QUEUED_ACTIONS)[number];

export const findQueuedTarget = (state: State, ref: string): QueuedMessage | null => {
	// The developer's own last words when they wait there, else what was queued last.
	const queue = state.sessions[ref]?.queue ?? [];
	const lastId = state.lastSpokenSend?.ref === ref ? state.lastSpokenSend.id : null;

	return queue.find((message) => message.id === lastId) ?? queue.at(-1) ?? null;
};

const preview = (text: string): string =>
	text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;

interface HandleQueuedMessageParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
}

export const handleQueuedMessage = ({
	state,
	input,
	toolContext,
}: HandleQueuedMessageParams): ToolResult => {
	const checked = checkRef(state, input.ref);

	if (!checked.ok) {
		return fail(checked.error);
	}

	const action = QUEUED_ACTIONS.find((known) => known === input.action);

	if (!action) {
		return fail('action is "now" or "drop"');
	}

	const target = findQueuedTarget(state, checked.ref);

	if (!target) {
		return fail(
			`nothing is queued for ${checked.ref}. To have words go now, forward them with kind redirect.`,
		);
	}

	log.info('queued message', { ref: checked.ref, action, chars: target.text.length });

	if (action === 'drop') {
		toolContext.dispatch({ type: 'cancel_queued', ref: checked.ref, queuedId: target.id });

		return succeed(`took "${preview(target.text)}" back from ${checked.ref}: it will not be sent`);
	}

	toolContext.dispatch({ type: 'promote_queued', ref: checked.ref, queuedId: target.id });

	return succeed(
		state.sessions[checked.ref]?.status === 'running'
			? `${checked.ref} stops its current work and takes "${preview(target.text)}" now`
			: `"${preview(target.text)}" goes first to ${checked.ref}`,
	);
};
