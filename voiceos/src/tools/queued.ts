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

export type Carrier =
	| { kind: 'queued' | 'aside' | 'held'; id: string; text: string }
	| { kind: 'running' }
	| null;

export const findCarrier = (state: State, ref: string): Carrier => {
	// Where the developer's last words to this session wait: queued, asked aside, held as a switch
	// question — or already being worked on. Otherwise the newest queued message.
	const session = state.sessions[ref];
	const last = state.lastSpokenSend?.ref === ref ? state.lastSpokenSend : null;

	if (!session) {
		return null;
	}

	if (last) {
		const held = state.asks.find((ask) => ask.id === last.id && ask.kind === 'redirect');
		const aside = session.stream.find(
			(item) => item.id === last.id && item.kind === 'aside' && item.status === 'asking',
		);

		if (held?.kind === 'redirect') {
			return { kind: 'held', id: held.id, text: held.text };
		}

		if (aside?.kind === 'aside') {
			return { kind: 'aside', id: aside.id, text: aside.question };
		}

		if (session.status === 'running' && session.currentSendId === last.id) {
			return { kind: 'running' };
		}
	}

	const queued = findQueuedTarget(state, ref);

	return queued ? { kind: 'queued', id: queued.id, text: queued.text } : null;
};

const preview = (text: string): string =>
	text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;

interface TakeBackParams {
	state: State;
	ref: string;
	toolContext: ToolContext;
}

const takeBack = ({ state, ref, toolContext }: TakeBackParams): ToolResult => {
	const carrier = findCarrier(state, ref);

	if (!carrier) {
		return fail(`nothing from the developer is waiting at ${ref}: there is nothing to take back`);
	}

	if (carrier.kind === 'running') {
		return fail(
			`${ref} is already working on those words: they cannot be taken back. If the developer wants it stopped, that is interrupt.`,
		);
	}

	log.info('taken back', { ref, from: carrier.kind, chars: carrier.text.length });
	toolContext.dispatch({ type: 'take_back', ref, id: carrier.id });

	return succeed(`took "${preview(carrier.text)}" back from ${ref}: it will not be sent`);
};

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

	if (action === 'drop') {
		return takeBack({ state, ref: checked.ref, toolContext });
	}

	const target = findQueuedTarget(state, checked.ref);

	if (!target) {
		return fail(
			`nothing is queued for ${checked.ref}. To have words go now, forward them with kind redirect.`,
		);
	}

	log.info('queued message now', { ref: checked.ref, chars: target.text.length });
	toolContext.dispatch({ type: 'promote_queued', ref: checked.ref, queuedId: target.id });

	return succeed(
		state.sessions[checked.ref]?.status === 'running'
			? `${checked.ref} stops its current work and takes "${preview(target.text)}" now`
			: `"${preview(target.text)}" goes first to ${checked.ref}`,
	);
};
