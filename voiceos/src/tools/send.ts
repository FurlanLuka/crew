import type { QueuedMessage, Session, State } from '../shared/protocol.js';
import { hasOpenQuestionMoved } from '../shared/questions.js';
import { createLogger } from '../log.js';
import { decideDelivery } from '../state/delivery.js';
import { isPlainConsent } from './consent.js';
import { normalizeSaid } from '../state/helpers.js';
import { findSessionsNamedIn } from './session-naming.js';
import { buildSituationNote } from '../sessions/voice-context.js';
import { type ToolResult, fail, succeed } from './results.js';
import type { SendAck } from '../shared/ack.js';
import type { ToolContext } from './tools.js';

const log = createLogger('tools');

interface BuildSessionNoteParams {
	session: Session;
	state: State;
	recent: string[];
}

export const buildSessionNote = ({
	session,
	state,
	recent,
}: BuildSessionNoteParams): string | undefined => {
	// A session's first message since it started carries what only Voice OS knows.
	const isFirstMessage =
		session.status === 'stopped' || (session.isFresh && session.queue.length === 0);

	if (!isFirstMessage) {
		return undefined;
	}

	return buildSituationNote({ servers: state.devServers[session.ref] ?? [], recent }) || undefined;
};

const BARE_REFUSAL_PATTERN = /^(?:no|nope|nah|deny|decline|don't|do not|cancel|reject)\b/i;
const MAX_BARE_ANSWER_WORDS = 4;

export const isBareAnswer = (text: string): boolean => {
	const words = normalizeSaid(text)
		.replace(/[.!?,]+/g, '')
		.split(' ');

	return (
		words.length <= MAX_BARE_ANSWER_WORDS &&
		(isPlainConsent(words.join(' ')) || BARE_REFUSAL_PATTERN.test(words.join(' ')))
	);
};

export const describeMisroutedAnswer = (state: State, ref: string, text: string): string | null => {
	// Anything else the developer says goes through, declining the permission or plan with their words:
	// they moved on. Only a bare yes or no sent as words is a routing slip that would decide the wrong way.
	const ask = state.asks.find((pendingAsk) => pendingAsk.ref === ref);

	if (!ask || ask.kind === 'question' || !isBareAnswer(text)) {
		return null;
	}

	return `"${text}" answers what ${ref} waits on (${ask.kind}): use the answer tool. Nothing was sent.`;
};

const findRunningRequest = (session: Session): string | null => {
	if (session.status !== 'running' && session.status !== 'blocked') {
		return null;
	}

	const lastRequest = session.stream.findLast((item) => item.kind === 'user');

	return lastRequest?.kind === 'user' ? lastRequest.text : null;
};

const isQueuedAlready = (message: QueuedMessage, sent: string): boolean => {
	const queued = normalizeSaid(message.text);

	// A spoken follow-up is merged onto the end of the message it follows, after a space.
	return queued === sent || (Boolean(message.isFollowUp) && queued.endsWith(` ${sent}`));
};

interface IsDuplicateSendParams {
	session: Session;
	text: string;
}

export const isDuplicateSend = ({ session, text }: IsDuplicateSendParams): boolean => {
	// Sending it again would interrupt the turn working on it; once that turn ends, a repeat is deliberate.
	const sent = normalizeSaid(text);
	const runningRequest = findRunningRequest(session);

	return (
		(runningRequest !== null && normalizeSaid(runningRequest) === sent) ||
		session.queue.some((message) => isQueuedAlready(message, sent))
	);
};

interface SendTextParams {
	state: State;
	ref: string;
	text: string;
	// The kernel's reading of the words: a question to a working session is answered aside.
	kind: unknown;
	toolContext: ToolContext;
	// These words finish the developer's previous ones; rest is only the new part.
	continues?: { rest: string };
}

const LEADING_ANSWER_PATTERN = /^\s*((?:yes|yeah|yep|sure|okay|ok|no|nope)\b[^.!?]*[.!?])\s*/i;

const keepLeadingAnswer = (utterance: string, text: string): string => {
	// "Yes, please. Let me know when you're done." answers the session's question: the rewrite kept
	// only the second sentence, and the session never heard the yes. Only a sentence that is an answer
	// on its own comes back: "No, use the table." rewritten as "Use the table." is already whole.
	const leading = LEADING_ANSWER_PATTERN.exec(utterance)?.[1];

	if (!leading || !isBareAnswer(leading)) {
		return text;
	}

	// What follows the answer word ("do it now" in "Yes, do it now.") may already be in the rewrite.
	const bare = (words: string): string => normalizeSaid(words).replace(/[.!?,]+/g, '');
	const written = bare(text);
	const rest = bare(leading).split(' ').slice(1).join(' ');

	if (written.startsWith(bare(leading)) || (rest && ` ${written} `.includes(` ${rest} `))) {
		return text;
	}

	return `${leading} ${text}`;
};

interface PrepareSentTextParams {
	state: State;
	ref: string;
	text: string;
	utterance: string | undefined;
	// The words go to this session alone: nothing else in the turn changed anything.
	isOnlySend: boolean;
}

// A sentence that asked for two things keeps only its half for the session: that is not a loss.
const MIN_KEPT_SHARE = 0.3;
const MIN_LONG_UTTERANCE_WORDS = 15;

const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export const isRewriteTooShort = (utterance: string, text: string): boolean => {
	// A long, rambling thought rewritten into a few words lost its point ("Okay, or just something
	// like that." for twenty-five words about confirmations): the session reads the words as said.
	const saidWords = countWords(utterance);

	return saidWords >= MIN_LONG_UTTERANCE_WORDS && countWords(text) < saidWords * MIN_KEPT_SHARE;
};

export const prepareSentText = ({
	state,
	ref,
	text,
	utterance,
	isOnlySend,
}: PrepareSentTextParams): string => {
	// As said only when the words were all for this session: split across sessions or tools, each
	// part is short on purpose, and the whole would hand one session the other's instruction.
	const namesAnother = utterance
		? findSessionsNamedIn(state, utterance).some((named) => named !== ref)
		: false;

	if (utterance && isOnlySend && !namesAnother && isRewriteTooShort(utterance, text)) {
		log.info('rewrite too short: sent as said', {
			ref,
			said: countWords(utterance),
			kept: countWords(text),
		});

		return utterance.trim();
	}

	// Only when the session asked something: elsewhere a leading "okay" is filler.
	return state.sessions[ref]?.needsUser && utterance ? keepLeadingAnswer(utterance, text) : text;
};

// "Voice OS, make a worktree…" addresses the setup session; "reinstall Voice OS" is about the app.
const SETUP_ADDRESS_PATTERN =
	/^\s*(?:(?:hey|okay|ok|so)[,\s]+)?(?:voice\s*os|voiceos|setup)\b\s*[,:]/i;
const SETUP_WORK_PATTERN =
	/\b(?:worktrees?|workspaces?|projects?|bindings?|crew (?:fix|verify|check)|register)\b/i;

export interface IsMisroutedToSetupParams {
	state: State;
	ref: string;
	// The session on screen when the words were said.
	forwardTo: string | null;
	utterance: string | undefined;
}

export const isMisroutedToSetup = ({
	state,
	ref,
	forwardTo,
	utterance,
}: IsMisroutedToSetupParams): boolean => {
	// "can you reinstall Voice OS" was sent to setup from crew/main's screen. Setup gets words from
	// another session's screen only when addressed or when they are crew setup.
	if (!state.sessions[ref]?.isPinned || !forwardTo || forwardTo === ref || !utterance) {
		return false;
	}

	return !SETUP_ADDRESS_PATTERN.test(utterance) && !SETUP_WORK_PATTERN.test(utterance);
};

const readKind = (kind: unknown): SendAck['kind'] =>
	kind === 'question' || kind === 'redirect' ? kind : 'instruction';

export const sendText = ({
	state,
	ref,
	text,
	kind,
	continues,
	toolContext,
}: SendTextParams): ToolResult => {
	const session = state.sessions[ref];

	if (session && isDuplicateSend({ session, text })) {
		log.info('duplicate send skipped', { ref, chars: text.length });

		return fail(`already sent to ${ref}; it is working on it: nothing was sent again`);
	}

	const wouldGoAside =
		session !== undefined &&
		decideDelivery({
			status: session.status,
			kind: readKind(kind),
			utterance: toolContext.utterance ?? text,
		}) === 'aside';
	// A continuation goes where its first half went (the reducer finds it), never aside on its own;
	// if that half already ran, the new part goes as these words would have.
	const delivery = wouldGoAside && !continues ? 'aside' : 'send';

	if (delivery === 'aside') {
		log.info('asked aside', { ref, chars: text.length });
		toolContext.dispatch({
			type: 'send',
			ref,
			text,
			aside: true,
			...(toolContext.isSpoken ? { isSpoken: true } : {}),
		});

		return {
			...succeed(`asked ${ref} aside, beside its work: its answer is spoken when it comes`),
			note: 'aside',
		};
	}

	// Words for a waiting question answer the open one; one that moved since they were said is not theirs.
	const heardAsk = toolContext.asks.find((ask) => ask.ref === ref);
	const liveAsk = state.asks.find((ask) => ask.id === heardAsk?.id);

	if (heardAsk && liveAsk && hasOpenQuestionMoved(heardAsk, liveAsk)) {
		log.info('words for a question answered meanwhile: not sent', { ref });

		return fail(
			`not sent: ${ref}'s question already has an answer and it now asks the next one. Tell the developer in a few words that their words were not used for it; do not read the next question (it is on the page, or Voice OS already read it).`,
		);
	}

	const note = session
		? buildSessionNote({ session, state, recent: toolContext.recentUtterances ?? [] })
		: undefined;

	if (continues) {
		log.info('continuation', { ref, chars: text.length });
	}

	toolContext.dispatch({
		type: 'send',
		ref,
		text,
		ack: { kind: readKind(kind) },
		...(continues
			? { continues: { ...continues, ...(wouldGoAside ? { isAside: true } : {}) } }
			: {}),
		...(note ? { note } : {}),
		...(toolContext.isSpoken ? { isSpoken: true } : {}),
	});

	return succeed(`sent to ${ref}`);
};
