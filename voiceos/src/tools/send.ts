import type { Judge } from '../judge/judge.js';
import { isHeldQuestion } from '../state/held-lines.js';
import { hasQuestionSince } from '../state/asks.js';
import {
	isSdkAsk,
	isSwitchOfferFresh,
	type QueuedMessage,
	type Session,
	type State,
	type SwitchOffer,
	type SwitchOfferKind,
} from '../shared/protocol.js';
import { hasOpenQuestionMoved } from '../shared/questions.js';
import { createLogger } from '../log.js';
import { countSpokenWords, normalizeSaid } from '../state/helpers.js';
import { findSessionsNamedIn } from './session-naming.js';
import { buildDiscordNote, buildSituationNote } from '../sessions/voice-context.js';
import { type ToolResult, fail, succeed } from './results.js';
import type { SendAck } from '../shared/ack.js';
import type { ToolContext } from './tools.js';
import type { NotesStore } from '../memory/notes.js';
import { decideDelivery, type DeliverWish, joinNotes } from '../state/delivery.js';
import { GENERAL_NOTES, nameNotes, readWorkspace } from '../shared/notes.js';
import { machineOf } from '../shared/machine-ref.js';
import { refuseAnnouncedOnly } from './announced.js';
import { findVoiceOsQuestion } from './asked-aloud.js';
import { describeRecentAction } from './recent-action.js';

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

interface BuildNotesPathNoteParams {
	ref: string;
	// The developer mentioned their own notes (the kernel's my_notes): "the release notes" and
	// "debug notes" are not theirs.
	isAsked: boolean;
	notes: NotesStore;
}

export const buildNotesPathNote = ({
	ref,
	isAsked,
	notes,
}: BuildNotesPathNoteParams): string | undefined => {
	// Only when the developer asked about their notes: a session is never handed them unasked.
	if (!isAsked) {
		return undefined;
	}

	const workspace = readWorkspace(ref);

	// The files are on this machine: a session on another one reads them through crew, which asks
	// the main over its link.
	if (machineOf(ref) !== null) {
		const command =
			workspace === GENERAL_NOTES ? 'crew server notes' : `crew server notes ${workspace}`;

		return `The developer's notes for ${nameNotes(workspace)} are on the main machine: run \`${command}\` to read them.`;
	}

	const path = notes.pathFor(workspace);

	return notes.has(workspace)
		? `The developer's notes for ${nameNotes(workspace)} are in ${path}.`
		: `The developer has no notes for ${nameNotes(workspace)} yet (they would be in ${path}).`;
};

const MAX_BARE_ANSWER_WORDS = 4;
// A yes this long after Voice OS's fix offer is still about it: the offer itself lapses sooner.
const OFFER_ANSWER_MS = 30 * 60_000;

// A few words at most: anything longer is more than a yes or a no, in any language.
export const isShortEnoughToAnswer = (text: string): boolean =>
	countSpokenWords(text) <= MAX_BARE_ANSWER_WORDS;

// Only a yes or a no, nothing more: the shape in code, the meaning from the judge.
export const isBareAnswer = async (judge: Judge, text: string): Promise<boolean> =>
	isShortEnoughToAnswer(text) && (await judge({ key: 'bare_answer', utterance: text })) === 'yes';

// A bare no: "no", "nein", "ne".
export const isBareNo = async (judge: Judge, text: string): Promise<boolean> =>
	isShortEnoughToAnswer(text) && (await judge({ key: 'refuses', utterance: text })) === 'yes';

// A bare yes: "yes, push it" is more than a yes.
export const isBareYes = async (judge: Judge, text: string): Promise<boolean> =>
	(await isBareAnswer(judge, text)) &&
	(await judge({ key: 'approves', utterance: text })) === 'yes';

// The developer's words are a bare yes to Voice OS's own open "Switch to X?" (or activate, deactivate):
// that yes is the offer's, whichever tool the kernel reached for. The offer as answered, or null.
export const readYesToOffer = async (
	state: State,
	toolContext: ToolContext,
): Promise<SwitchOffer | null> => {
	const offer = state.switchOffer;
	const said = toolContext.utterance;

	// The cheap checks first: most turns have no open offer, and those cost no judge call.
	if (
		!offer ||
		said === undefined ||
		!isSwitchOfferFresh(offer, toolContext.heardFrom ?? toolContext.now()) ||
		hasQuestionSince(state, offer.at)
	) {
		return null;
	}

	return (await isBareYes(toolContext.judge, said)) ? offer : null;
};

interface DescribeMisroutedAnswerParams {
	state: State;
	ref: string;
	text: string;
	judge: Judge;
}

export const describeMisroutedAnswer = async ({
	state,
	ref,
	text,
	judge,
}: DescribeMisroutedAnswerParams): Promise<string | null> => {
	// Anything else the developer says goes through, declining the permission or plan with their words:
	// they moved on. Only a bare yes or no sent as words is a routing slip that would decide the wrong way.
	const ask = state.asks.find((pendingAsk) => pendingAsk.ref === ref);

	if (!ask || ask.kind === 'question' || !(await isBareAnswer(judge, text))) {
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
	// The developer mentioned their own notes (the kernel's my_notes): their path goes with the words.
	isAboutMyNotes?: boolean;
	// The words point back at what Voice OS just did (the kernel's about_last_action).
	isAboutLastAction?: boolean;
	// How the developer said the words should reach a busy session (the kernel's deliver).
	deliver?: DeliverWish;
}

const toSaidWords = (text: string): string[] =>
	text
		.toLowerCase()
		// "/clear" is how "slash clear" is written: the same words.
		.replace(/\//g, ' slash ')
		.replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
		.replace(/'/g, '')
		.split(/\s+/)
		.filter(Boolean);

// Word for word, whole words only: "test" is no span of "run the tests".
export const isVerbatimSpan = (part: string, words: string): boolean => {
	const partWords = toSaidWords(part);
	const saidWords = toSaidWords(words);

	if (partWords.length === 0 || partWords.length > saidWords.length) {
		return false;
	}

	return saidWords.some((_, start) =>
		partWords.every((word, offset) => saidWords[start + offset] === word),
	);
};

// "…scratch that, run the linter instead": what came before is taken back, not sent.
const isAfterTakeBack = async (judge: Judge, said: string, part: string): Promise<boolean> =>
	(await judge({
		key: 'take_back_before',
		utterance: said,
		context: `The part: "${part}"`,
	})) === 'yes';

const isSameWords = (part: string, words: string): boolean =>
	toSaidWords(part).join(' ') === toSaidWords(words).join(' ');

interface IsWholeSendParams {
	state: State;
	utterance: string;
	// Nothing else in the turn carried words: the utterance was all for this session.
	isOnlySend: boolean;
}

export const isWholeSend = ({ state, utterance, isOnlySend }: IsWholeSendParams): boolean =>
	// Split across sessions or tools, the whole would hand one session the other's instruction; a
	// session named at all ("switch to checkout and tell it to…") means some words were routing.
	isOnlySend && findSessionsNamedIn(state, utterance).length === 0;

export interface ChooseSentWordsParams {
	// The words as heard.
	utterance: string | undefined;
	// What the kernel copied out of them, when the words did more than this send.
	part: string | undefined;
	// The developer's earlier words on this screen, oldest first: "I meant this for store front
	// main" resends them.
	earlier: string[];
	isWhole: boolean;
	// Asked only when the part could be what follows a take-back ("…scratch that, run the linter").
	judge: Judge;
}

export type SentWords = { text: string; source: 'said' | 'part' | 'earlier' };

// The kernel chooses where words go, never what they say: a model's rewrite lost the point of long
// thoughts. It may only copy a part out, word for word; anything else sends the words as said.
export const chooseSentWords = async ({
	utterance,
	part,
	earlier,
	isWhole,
	judge,
}: ChooseSentWordsParams): Promise<SentWords> => {
	const said = utterance?.trim() ?? '';
	const copied = part?.trim() ?? '';

	if (!said) {
		return { text: copied, source: 'part' };
	}

	if (!copied) {
		return { text: said, source: 'said' };
	}

	if (!isVerbatimSpan(copied, said) && earlier.some((words) => isVerbatimSpan(copied, words))) {
		return { text: copied, source: 'earlier' };
	}

	// The same words, written: "Slash clear." goes as /clear.
	if (isSameWords(copied, said)) {
		return { text: copied, source: 'part' };
	}

	// All of it was for this session, but the part is what came after they took the rest back.
	if (isWhole && isVerbatimSpan(copied, said) && (await isAfterTakeBack(judge, said, copied))) {
		return { text: copied, source: 'part' };
	}

	if (isWhole) {
		return { text: said, source: 'said' };
	}

	if (isVerbatimSpan(copied, said)) {
		return { text: copied, source: 'part' };
	}

	log.warn('part not word for word: sent as said', {
		said: toSaidWords(said).length,
		part: toSaidWords(copied).length,
	});

	return { text: said, source: 'said' };
};

const readKind = (kind: unknown): SendAck['kind'] =>
	kind === 'question' || kind === 'redirect' ? kind : 'instruction';

interface RecordAsSentParams {
	ref: string;
	text: string;
	kind?: 'question';
	toolContext: ToolContext;
}

// Words another tool sent on are remembered as the send they were, so a follow-up ("send that
// again") is read against what the session actually got.
export const recordAsSent = ({
	ref,
	text,
	kind,
	toolContext,
}: RecordAsSentParams): NonNullable<ToolResult['recordAs']> => {
	const extra = kind ? { kind } : {};

	return toolContext.forwardTo === ref
		? { name: 'forward', input: { text, ...extra } }
		: { name: 'send_to', input: { ref, text, ...extra } };
};

// What a yes to Voice OS's own question about a session does.
export const describeOfferAnswer = (kind: SwitchOfferKind | undefined, ref: string): string => {
	switch (kind) {
		case 'activate':
			return `"Activate it?" about ${ref}: call activate with name ${ref}`;
		case 'deactivate':
			return `"Deactivate anyway?" about ${ref}: call deactivate ${ref}`;
		default:
			return `"Switch to ${ref}?": call switch_view ${ref}`;
	}
};

export const sendText = async ({
	state,
	ref,
	text,
	kind,
	continues,
	toolContext,
	isAboutMyNotes = false,
	isAboutLastAction = false,
	deliver,
}: SendTextParams): Promise<ToolResult> => {
	const session = state.sessions[ref];
	const said = toolContext.utterance ?? text;
	const { judge } = toolContext;

	// "No" or "yes" to Voice OS's own "Switch to checkout?" answers Voice OS, not words for a session.
	// Fresh when the words were said: the kernel's own turn does not use up the developer's window.
	const saidAt = toolContext.heardFrom ?? toolContext.now();

	if (
		isSwitchOfferFresh(state.switchOffer, saidAt) &&
		!hasQuestionSince(state, state.switchOffer.at)
	) {
		const offered = state.switchOffer.ref;

		if (await isBareNo(judge, said)) {
			log.info('no to the switch offer: not sent', { ref });

			return fail(
				`That "no" answers Voice OS's question about ${offered}: nothing changes. Nothing was sent; say nothing.`,
			);
		}

		// Only a bare yes: "yes, push it" is words for a session, even while the offer is open.
		if (await isBareYes(judge, said)) {
			log.info('yes to the switch offer: not sent', { ref });

			return fail(
				`That yes answers Voice OS's ${describeOfferAnswer(state.switchOffer.kind, offered)}. Nothing was sent.`,
			);
		}
	}

	// "Yes, fix it" after Voice OS offered to fix this session's servers answers Voice OS, even once
	// the offer lapsed: the session never asked it, and dev_offer says the offer is gone.
	if (
		state.devOffer?.ref === ref &&
		toolContext.now() - state.devOffer.at < OFFER_ANSWER_MS &&
		isShortEnoughToAnswer(said) &&
		(await judge({ key: 'approves', utterance: said })) === 'yes'
	) {
		log.info('yes to the fix offer: not sent', { ref });

		return fail(
			`That yes answers Voice OS's offer to fix ${ref}'s dev servers: call dev_offer, which says whether the offer still holds. Nothing was sent.`,
		);
	}

	// A bare yes or no right after Voice OS asked something of its own ("Did you mean the debug notes?")
	// answers Voice OS; the screen's session would get a stray "yes" (a session the words name is told
	// on purpose). It comes after the offers above, which answer their own questions more precisely, and
	// judges the words chosen to send, so an earlier question the kernel offered to pass on still goes.
	const voiceOsQuestion = findVoiceOsQuestion({
		spoken: state.spoken,
		now: toolContext.now(),
		heardFrom: saidAt,
	});
	const sessionAsked = session?.needsUser;

	if (
		voiceOsQuestion &&
		ref === toolContext.forwardTo &&
		!(sessionAsked && sessionAsked.at > voiceOsQuestion.at) &&
		(await isBareAnswer(judge, text))
	) {
		log.info("a bare answer to Voice OS's own question: not sent", { ref });

		return fail(
			`"${text}" answers Voice OS's own question ("${voiceOsQuestion.text}"), not ${ref}: act on that answer yourself. Nothing was sent.`,
		);
	}

	// A bare yes or no for a question only announced there answers nothing the developer heard.
	const refused =
		isHeldQuestion(session) && (await isBareAnswer(judge, said))
			? await refuseAnnouncedOnly({ state, ref, toolContext, what: 'sent' })
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
				utterance: said,
				wanted: deliver ?? 'default',
			})
		: 'send';
	const wouldGoAside = decided === 'aside';
	const isNow = decided === 'now' && !continues;
	// A continuation goes where its first half went (the reducer finds it), never aside on its own;
	// if that half already ran, the new part goes as these words would have.
	const delivery = wouldGoAside && !continues ? 'aside' : 'send';
	const recentAction = describeRecentAction(state, {
		ref,
		screen: toolContext.screen,
		now: toolContext.now(),
		isReferredTo: isAboutLastAction,
	});

	if (delivery === 'aside') {
		log.info('asked aside', { ref, chars: text.length });
		const asideNote = [
			buildNotesPathNote({ ref, isAsked: isAboutMyNotes, notes: toolContext.notes }),
			recentAction,
			buildDiscordNote(state),
		].reduce(joinNotes, undefined);

		toolContext.sentTo?.add(ref);
		toolContext.dispatch({
			type: 'send',
			ref,
			text,
			aside: true,
			...(asideNote ? { note: asideNote } : {}),
			...(toolContext.isSpoken ? { isSpoken: true, saidOn: toolContext.screen ?? null } : {}),
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

	const note = [
		session
			? buildSessionNote({ session, state, recent: toolContext.recentUtterances ?? [] })
			: undefined,
		buildNotesPathNote({ ref, isAsked: isAboutMyNotes, notes: toolContext.notes }),
		recentAction,
		buildDiscordNote(state),
	].reduce(joinNotes, undefined);

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
		...(toolContext.isSpoken ? { isSpoken: true, saidOn: toolContext.screen ?? null } : {}),
		...(isNow ? { isNow: true } : {}),
	});

	return succeed(
		isNow
			? `sent to ${ref}: it stops its current work and takes these words now`
			: `sent to ${ref}`,
	);
};
