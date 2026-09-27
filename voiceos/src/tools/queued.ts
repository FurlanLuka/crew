import type { LastSpokenSend, State } from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { type ToolResult, checkRef, fail, succeed } from './results.js';
import type { ToolContext } from './tools.js';

const log = createLogger('tools');

const PREVIEW_CHARS = 60;

export const QUEUED_ACTIONS = ['now', 'drop'] as const;
export type QueuedAction = (typeof QUEUED_ACTIONS)[number];

interface FindTargetParams {
	state: State;
	ref: string;
	// The developer's last words as they stood when these were said: a send earlier in the same turn
	// must not move what "take that back" means.
	last: LastSpokenSend | null;
}

const readLastFor = (last: LastSpokenSend | null, ref: string): LastSpokenSend | null =>
	last?.ref === ref ? last : null;

type Waiting = { id: string; text: string } & { kind: 'queued' | 'aside' | 'held' };

export type Carrier = Waiting | { kind: 'working' } | { kind: 'sent' } | null;

export const findCarrier = ({ state, ref, last: lastSaid }: FindTargetParams): Carrier => {
	// Where the developer's last words to this session are: queued, asked aside, held as a switch
	// question, being worked on, or already sent. With none said to it, the newest queued message.
	const session = state.sessions[ref];
	const last = readLastFor(lastSaid, ref);

	if (!session) {
		return null;
	}

	if (!last) {
		const queued = session.queue.at(-1);

		return queued ? { kind: 'queued', id: queued.id, text: queued.text } : null;
	}

	const held = state.asks.find((ask) => ask.id === last.id && ask.kind === 'redirect');
	const aside = session.stream.find(
		(item) => item.id === last.id && item.kind === 'aside' && item.status === 'asking',
	);
	const queued = session.queue.find((message) => message.id === last.id);

	if (held?.kind === 'redirect') {
		return { kind: 'held', id: held.id, text: held.text };
	}

	if (aside?.kind === 'aside') {
		return { kind: 'aside', id: aside.id, text: aside.question };
	}

	if (queued) {
		return { kind: 'queued', id: queued.id, text: queued.text };
	}

	return session.currentSendId === last.id ? { kind: 'working' } : { kind: 'sent' };
};

const preview = (text: string): string =>
	text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;

const describeNotQueued = (ref: string, carrier: Carrier): string => {
	switch (carrier?.kind) {
		case 'held':
			return `those words wait as a switch question at ${ref}: answer it yes to have them go now`;
		case 'aside':
			return `those words were asked aside at ${ref}: to have them done now, forward them with kind redirect`;
		case 'working':
		case 'sent':
			return `${ref} already has those words: nothing queued to send now`;
		default:
			return `nothing is queued for ${ref}. To have words go now, forward them with kind redirect.`;
	}
};

const readLastSaid = (state: State, toolContext: ToolContext): LastSpokenSend | null =>
	toolContext.lastSpokenSend === undefined ? state.lastSpokenSend : toolContext.lastSpokenSend;

interface TakeBackParams {
	state: State;
	ref: string;
	toolContext: ToolContext;
}

const takeBack = ({ state, ref, toolContext }: TakeBackParams): ToolResult => {
	const carrier = findCarrier({ state, ref, last: readLastSaid(state, toolContext) });

	if (!carrier) {
		return fail(`nothing from the developer is waiting at ${ref}: there is nothing to take back`);
	}

	if (!('id' in carrier)) {
		return fail(
			`${ref} already has those words (${carrier.kind === 'working' ? 'it is working on them' : 'they were sent'}): they cannot be taken back. If it should stop, that is interrupt.`,
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

	const carrier = findCarrier({ state, ref: checked.ref, last: readLastSaid(state, toolContext) });

	if (carrier?.kind !== 'queued') {
		return fail(describeNotQueued(checked.ref, carrier));
	}

	const target = carrier;

	log.info('queued message now', { ref: checked.ref, chars: target.text.length });
	toolContext.dispatch({ type: 'promote_queued', ref: checked.ref, queuedId: target.id });

	return succeed(
		state.sessions[checked.ref]?.status === 'running'
			? `${checked.ref} stops its current work and takes "${preview(target.text)}" now`
			: `"${preview(target.text)}" goes first to ${checked.ref}`,
	);
};
