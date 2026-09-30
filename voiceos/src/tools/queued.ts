import { isSdkAsk, type LastSpokenSend, type State } from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { isDevelopersMessage } from '../state/delivery.js';
import { type ToolResult, checkRef, fail, succeed } from './results.js';
import type { ToolContext } from './tools.js';
import { recordAsSent, sendText } from './send.js';

const log = createLogger('tools');

const PREVIEW_CHARS = 60;
// Neutral on purpose: a take-back is not always a misroute, and a false reason sent the session
// explaining a mistake nobody made.
export const TAKEN_BACK = 'The developer took back their last message: ignore it; no reply needed.';

// The whole utterance, so "no, remove that, what I meant is…" is a correction, not a take-back.
const BARE_TAKE_BACK_PATTERN =
	/^(?:(?:oh|no|sorry|actually|okay|ok|wait|um|uh)[,.!\s]+)*(?:take (?:that|it) back|cancel that|never ?mind|scratch that|forget (?:that|it)|ignore that)(?:[,\s]+please)?[.!\s]*$/i;

export const isBareTakeBack = (utterance: string | undefined): boolean =>
	// Typed or replayed without words: the tool call is the only word there is.
	!utterance?.trim() || BARE_TAKE_BACK_PATTERN.test(utterance.trim());

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
	// question, being worked on, or already sent. With none said to it, the newest they queued.
	const session = state.sessions[ref];
	const last = readLastFor(lastSaid, ref);

	if (!session) {
		return null;
	}

	if (!last) {
		const queued = session.queue.filter(isDevelopersMessage).at(-1);

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

const sendCorrection = ({ state, ref, toolContext }: TakeBackParams): ToolResult => {
	if (toolContext.sentTo?.has(ref)) {
		return succeed(
			`not taken back: those words correct what ${ref} already has, and they went to it in this turn`,
		);
	}

	const said = (toolContext.utterance ?? '').trim();
	const sent = sendText({ state, ref, text: said, kind: 'instruction', toolContext });

	if (!sent.ok) {
		return sent;
	}

	log.info('take-back was a correction: sent as said', { ref, chars: said.length });

	return {
		...succeed(
			`not taken back: those words correct what ${ref} already has, so they went to it as said instead`,
		),
		recordAs: recordAsSent({ ref, text: said, toolContext }),
	};
};

const takeBack = ({ state, ref, toolContext }: TakeBackParams): ToolResult => {
	const carrier = findCarrier({ state, ref, last: readLastSaid(state, toolContext) });

	if (!carrier) {
		return fail(`nothing from the developer is waiting at ${ref}: there is nothing to take back`);
	}

	// Waiting on a permission, plan or question those words led to: anything sent now would answer
	// it, so the kernel answers it no instead.
	const pendingAsk = state.asks.find((ask) => ask.ref === ref && isSdkAsk(ask));

	if (!('id' in carrier) && pendingAsk) {
		return fail(
			`${ref} already got those words and now waits on a ${pendingAsk.kind} from them: answer it no, with text "That was not meant for you."`,
		);
	}

	// Already delivered: words that only take it back tell it to ignore them. Anything more is a
	// correction for the session, which undoing would lose ("remove that, I meant the TTS tags").
	if (!('id' in carrier)) {
		if (!isBareTakeBack(toolContext.utterance)) {
			return sendCorrection({ state, ref, toolContext });
		}

		log.info('taken back after delivery', { ref, carrier: carrier.kind });
		toolContext.dispatch({ type: 'send', ref, text: TAKEN_BACK });

		return succeed(
			carrier.kind === 'working'
				? `${ref} was already working on those words: it was told the developer took them back (it reads that after its current turn; if it should stop now, that is interrupt)`
				: `${ref} already had those words: it was told the developer took them back`,
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
	const isRunning = state.sessions[checked.ref]?.status === 'running';
	const waiting = state.sessions[checked.ref]?.queue.filter(isDevelopersMessage) ?? [];

	// "Send both now": with more than one of theirs waiting, "now" means all of them, as one message.
	if (waiting.length > 1) {
		log.info('all queued messages now', { ref: checked.ref, count: waiting.length });
		toolContext.dispatch({ type: 'promote_all_queued', ref: checked.ref });

		return succeed(
			isRunning
				? `${checked.ref} stops its current work and takes all ${waiting.length} queued messages now, as one`
				: `all ${waiting.length} queued messages go first to ${checked.ref}, as one`,
		);
	}

	log.info('queued message now', { ref: checked.ref, chars: target.text.length });
	toolContext.dispatch({ type: 'promote_queued', ref: checked.ref, queuedId: target.id });

	return succeed(
		isRunning
			? `${checked.ref} stops its current work and takes "${preview(target.text)}" now`
			: `"${preview(target.text)}" goes first to ${checked.ref}`,
	);
};
