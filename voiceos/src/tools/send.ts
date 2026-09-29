import { isSdkAsk, type QueuedMessage, type Session, type State } from '../shared/protocol.js';
import { hasOpenQuestionMoved } from '../shared/questions.js';
import { endsInQuestion } from '../shared/spoken.js';
import { createLogger } from '../log.js';
import { isPlainConsent } from './consent.js';
import { normalizeSaid } from '../state/helpers.js';
import { findSessionsNamedIn } from './session-naming.js';
import { buildSituationNote } from '../sessions/voice-context.js';
import { type ToolResult, fail, succeed } from './results.js';
import type { SendAck } from '../shared/ack.js';
import type { ToolContext } from './tools.js';
import type { NotesStore } from '../memory/notes.js';
import { decideDelivery, joinNotes } from '../state/delivery.js';
import { nameNotes, readWorkspace } from '../shared/notes.js';
import { refuseAnnouncedOnly } from './announced.js';

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

// "my notes", "my own notes": the developer's. "the release notes", "debug notes" are not.
const MY_NOTES_PATTERN = /\bmy (?:own )?notes\b/i;

interface BuildNotesPathNoteParams {
	ref: string;
	utterance: string | undefined;
	notes: NotesStore;
}

export const buildNotesPathNote = ({
	ref,
	utterance,
	notes,
}: BuildNotesPathNoteParams): string | undefined => {
	// Only when the developer asked about their notes, as said (never the kernel's rewrite): a
	// session is never handed them unasked.
	if (!utterance || !MY_NOTES_PATTERN.test(utterance)) {
		return undefined;
	}

	const workspace = readWorkspace(ref);
	const path = notes.pathFor(workspace);

	return notes.has(workspace)
		? `The developer's notes for ${nameNotes(workspace)} are in ${path}.`
		: `The developer has no notes for ${nameNotes(workspace)} yet (they would be in ${path}).`;
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
	// The text joins two utterances: the one heard now is only its second half.
	isContinuation?: boolean;
}

// A sentence that asked for two things keeps only its half for the session: that is not a loss.
const MIN_KEPT_SHARE = 0.3;
const MIN_LONG_UTTERANCE_WORDS = 15;

const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export const isQuestionRewritten = (utterance: string, text: string): boolean =>
	// "Does the router still drop the header?" rewritten as "Check whether the router drops the
	// header." sets it to work on what was only asked.
	endsInQuestion(utterance) && !endsInQuestion(text);

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
	isContinuation = false,
}: PrepareSentTextParams): string => {
	// As said only when the words were all for this session: split across sessions or tools, each
	// part is short on purpose, and the whole would hand one session the other's instruction.
	const namesAnother = utterance
		? findSessionsNamedIn(state, utterance).some((named) => named !== ref)
		: false;

	const isWhole = Boolean(utterance) && isOnlySend && !namesAnother;

	if (utterance && isWhole && isRewriteTooShort(utterance, text)) {
		log.info('rewrite too short: sent as said', {
			ref,
			said: countWords(utterance),
			kept: countWords(text),
		});

		return utterance.trim();
	}

	if (utterance && isWhole && !isContinuation && isQuestionRewritten(utterance, text)) {
		log.info('question rewritten as a statement: sent as said', { ref });

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

// "Add a debug note: …" is Voice OS's own tool; talk about debug notes ("read the debug notes") is
// work for the session.
const DEBUG_NOTE_REQUEST_PATTERN =
	/^\s*(?:(?:okay|ok|so|hey|and|please)[,\s]+)*(?:(?:can|could|would) you\s+)?(?:add|take|make)\s+(?:a\s+|another\s+)?debug\s*notes?\b/i;

export const describeDebugNoteRequest = (utterance: string | undefined): string | null =>
	// Read off the words as said: the kernel's rewrite may have dropped the request.
	utterance !== undefined && DEBUG_NOTE_REQUEST_PATTERN.test(utterance)
		? 'that is debug_note: the developer asked Voice OS for a debug note, not the session. Call debug_note with their words. Nothing was sent.'
		: null;

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
	const debugNoteRequest = describeDebugNoteRequest(toolContext.utterance);

	if (debugNoteRequest) {
		log.info('debug note request not sent', { ref });

		return fail(debugNoteRequest);
	}

	// A bare yes or no for a question only announced there answers nothing the developer heard.
	const refused = isBareAnswer(toolContext.utterance ?? text)
		? refuseAnnouncedOnly({ state, ref, toolContext, what: 'sent' })
		: null;

	if (refused) {
		return refused;
	}

	if (session && isDuplicateSend({ session, text })) {
		log.info('duplicate send skipped', { ref, chars: text.length });

		return fail(`already sent to ${ref}; it is working on it: nothing was sent again`);
	}

	const decided = session
		? decideDelivery({
				status: session.status,
				kind: readKind(kind),
				utterance: toolContext.utterance ?? text,
			})
		: 'send';
	const wouldGoAside = decided === 'aside';
	const isNow = decided === 'now' && !continues;
	// A continuation goes where its first half went (the reducer finds it), never aside on its own;
	// if that half already ran, the new part goes as these words would have.
	const delivery = wouldGoAside && !continues ? 'aside' : 'send';

	if (delivery === 'aside') {
		log.info('asked aside', { ref, chars: text.length });
		const notesPath = buildNotesPathNote({
			ref,
			utterance: toolContext.utterance,
			notes: toolContext.notes,
		});

		toolContext.sentTo?.add(ref);
		toolContext.dispatch({
			type: 'send',
			ref,
			text,
			aside: true,
			...(notesPath ? { note: notesPath } : {}),
			...(toolContext.isSpoken ? { isSpoken: true } : {}),
		});

		// A question about a pending question withdraws it (the reducer denies it with these words):
		// the session answers, then asks again.
		const isWithdrawing =
			state.asks.filter(isSdkAsk).find((ask) => ask.ref === ref)?.kind === 'question';

		return isWithdrawing
			? {
					...succeed(
						`${ref}'s question is withdrawn: the developer's words went to it instead, and it answers them, then asks the question again`,
					),
					note: 'question withdrawn',
				}
			: {
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

	const note = joinNotes(
		session
			? buildSessionNote({ session, state, recent: toolContext.recentUtterances ?? [] })
			: undefined,
		buildNotesPathNote({ ref, utterance: toolContext.utterance, notes: toolContext.notes }),
	);

	if (continues) {
		log.info('continuation', { ref, chars: text.length });
	}

	toolContext.sentTo?.add(ref);
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
		...(isNow ? { isNow: true } : {}),
	});

	return succeed(
		isNow
			? `sent to ${ref}: it stops its current work and takes these words now`
			: `sent to ${ref}`,
	);
};
