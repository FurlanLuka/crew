import {
	isOfferFresh,
	OFFER_TTL_MS,
	type Action,
	type LastSpokenSend,
	type PendingAsk,
	type State,
} from '../shared/protocol.js';
import { formatAge } from '../state/working.js';
import { describeMisroutedAnswer, isMisroutedToSetup, prepareSentText, sendText } from './send.js';
import { isAboutHandsFree, readHandsFreeDirection, type HandsFreeResult } from './hands-free.js';
import { answerAsk } from './answer.js';
import { handleQueuedMessage } from './queued.js';
import type { HistoryQuery } from '../memory/journal.js';
import type { DebugNoteWords } from '../memory/debug-notes.js';
import type { NotesStore } from '../memory/notes.js';
import { GENERAL_NOTES, nameNotes, readNoteText, readWorkspace } from '../shared/notes.js';
import { createLogger } from '../log.js';
import { normalizeName } from '../router/refs.js';
import type { ToolName } from './definitions.js';
import { findNamedRefs, findSessionsNamedIn } from './session-naming.js';
import { describeSession, findLatestDenial } from './session-view.js';
import { type ToolResult, fail, succeed, checkRef } from './results.js';

const MIN_REQUEST_WORDS = 4;
const log = createLogger('tools');

const NOTES_READ_BACK = 10;

interface ReadNoteWorkspaceParams {
	state: State;
	named: unknown;
	screen: string | null | undefined;
}

const readNoteWorkspace = ({ state, named, screen }: ReadNoteWorkspaceParams): string | null => {
	// A workspace the developer named — matched the way session names are ("storefront" is
	// store-front) — else the one on screen; on Mission Control, the general notes. null: the name
	// matched none.
	if (typeof named !== 'string' || !named.trim()) {
		return readWorkspace(screen);
	}

	const known = [...state.order.map((ref) => readWorkspace(ref)), ...Object.keys(state.notes)];
	const spoken = normalizeName(named);
	// The general notes only when no workspace answers to the name: a real "general" wins it.
	const workspace = known
		.filter((key) => key !== GENERAL_NOTES)
		.find((key) => normalizeName(key) === spoken);

	if (workspace) {
		return workspace;
	}

	return spoken === normalizeName(GENERAL_NOTES) ? GENERAL_NOTES : null;
};

// "…and fix the login bug", "…then run the seeds": new work named. A pause ("stop and wait",
// "stop, let me look") or "I'll do it myself instead" names none for the session: it still stops.
const SAYS_WHAT_INSTEAD_PATTERN =
	/\b(?:stop|cancel|halt|drop)\b[^.?!]*\b(?:and|then)\s+(?!(?:wait|hold|pause|listen|look|think|let)\b)\w+/i;
const MIN_LONG_SPEECH_WORDS = 10;
const REQUEST_OPENING_PATTERN =
	/^(?:(?:and|so|okay|ok|um|uh)[,\s]+)*(?:can|could|would|will) you\b|^(?:(?:and|so)[,\s]+)?(?:what|which|who|where|when|why|how)\b/i;

export interface HistoryEntry {
	ts: string;
	ref: string;
	asked: string | null;
	did: string;
}

export interface ToolContext {
	getState: () => State;
	// Lets destructive calls check it named one session; a follow-up names it with the one before.
	utterance?: string;
	// Oldest first: the follow-up check, and the context a newly started session is given.
	recentUtterances?: string[];
	// Captured at routing, so a view that changes while the model thinks cannot redirect forward.
	forwardTo?: string | null;
	// The session on screen when the words were said: "end this session" names it.
	screen?: string | null;
	// Spoken, not typed: a follow-up that may interrupt the reply it follows.
	isSpoken?: boolean;
	// Pending when the words were said: never answer one that opened while the model thought.
	asks: PendingAsk[];
	// Required so a server that forgets to wire them fails to compile, not a "Noted." that saved nothing.
	mute: () => void;
	saveDebugNote: (words: DebugNoteWords) => void;
	// The developer's own notes, per workspace.
	notes: NotesStore;
	// Calls that change something in this turn so far, this step's included: more than one splits the words.
	actionsInTurn?: number;
	// Sessions this turn already sent words to: an answer that would send them again does not.
	sentTo?: Set<string>;
	// The developer's last words to a session as they stood when these were said.
	lastSpokenSend?: LastSpokenSend | null;
	// When the developer began saying these words: anything a session asked after that, unheard.
	heardFrom?: number;
	// Bound to the tab the words came from; 'no_tab' when they came from none (evals, a closed tab).
	setHandsFree: (isOn: boolean) => HandsFreeResult;
	dispatch: (action: Action) => void;
	now: () => number;
	readHistory: (query: HistoryQuery) => HistoryEntry[];
}

interface SendRecordedParams {
	state: State;
	ref: string;
	text: string;
	input: Record<string, unknown>;
	name: 'forward' | 'send_to';
	toolContext: ToolContext;
}

const sendRecorded = ({
	state,
	ref,
	text,
	input,
	name,
	toolContext,
}: SendRecordedParams): ToolResult => {
	const sent = prepareSentText({
		state,
		ref,
		text,
		utterance: toolContext.utterance,
		isOnlySend: (toolContext.actionsInTurn ?? 1) <= 1,
	});
	const rest = typeof input.rest === 'string' && input.rest.trim() ? input.rest.trim() : null;
	const result = sendText({
		state,
		ref,
		text: sent,
		kind: input.kind,
		// Without the kernel's own rewrite of the new part, the words as said stand in for it.
		...(input.continues === true
			? {
					continues: {
						rest:
							rest ??
							prepareSentText({
								state,
								ref,
								text: toolContext.utterance?.trim() || sent,
								utterance: toolContext.utterance,
								isOnlySend: true,
							}),
					},
				}
			: {}),
		toolContext,
	});

	// The voice log records what the session got, not what the model wrote.
	return sent === text
		? result
		: { ...result, recordAs: { name, input: { ...input, text: sent } } };
};

export const executeTool = async (
	name: string,
	input: Record<string, unknown>,
	toolContext: ToolContext,
): Promise<ToolResult> => {
	const state = toolContext.getState();

	switch (name as ToolName) {
		case 'forward': {
			const target = toolContext.forwardTo;

			if (!target || !state.sessions[target]) {
				return fail('no session to forward to: use send_to with a ref');
			}

			const text = typeof input.text === 'string' ? input.text.trim() : '';

			if (!text) {
				return fail('empty text');
			}

			const misroutedAnswer = describeMisroutedAnswer(state, target, text);

			if (misroutedAnswer) {
				return fail(misroutedAnswer);
			}

			return sendRecorded({ state, ref: target, text, input, name: 'forward', toolContext });
		}

		case 'ignore_words': {
			// A finished request is never an unfinished thought: "can you, um, close the agent?" and
			// "and can you tell me what's running." were taken for ones. Short ones stay ignorable
			// (speech-to-text punctuates a cut-off "and can you?" too), and so does a lyric or a video.
			const said = (toolContext.utterance ?? '').trim();
			const isRequest =
				(/\?$/.test(said) || REQUEST_OPENING_PATTERN.test(said)) &&
				said.split(/\s+/).length >= MIN_REQUEST_WORDS;

			// Fragments are a few words ("and can you"); a long stretch of speech is a thought or not
			// for anyone — the developer's own thinking aloud was ignored as "unfinished".
			const isLong = said.split(/\s+/).length >= MIN_LONG_SPEECH_WORDS;

			// A thought cut off mid-word ("…the thing with the—") is a fragment however long.
			const isCutOff = /(?:—|-|…|\.\.\.)$/.test(said);

			if (input.reason === 'unfinished thought' && !isCutOff && (isRequest || isLong)) {
				return fail(
					"Not ignored as unfinished: that is not a fragment. Does it have anything to do with the work on screen, a session or Voice OS? If not (a song lyric, a recipe, someone else talking), call ignore_words with 'not said to anyone'. If it does, forward it.",
				);
			}

			return succeed('nothing done or said');
		}

		case 'read_state': {
			const now = toolContext.now();

			if (input.ref === null || input.ref === undefined) {
				return succeed(
					state.order.map((ref) => describeSession({ state, ref, isDetailed: false, now })),
				);
			}

			const checked = checkRef(state, input.ref);

			return checked.ok
				? succeed(describeSession({ state, ref: checked.ref, isDetailed: true, now }))
				: fail(checked.error);
		}

		case 'read_history': {
			const limit = Math.min(20, Math.max(1, Number(input.limit) || 5));
			const checked = typeof input.ref === 'string' ? checkRef(state, input.ref) : null;

			if (checked && !checked.ok) {
				return fail(checked.error);
			}

			const query = typeof input.query === 'string' && input.query.trim() ? input.query : null;

			return succeed(
				toolContext.readHistory({ ref: checked?.ok ? checked.ref : null, query, limit }),
			);
		}

		case 'send_to': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			const text = typeof input.text === 'string' ? input.text.trim() : '';

			if (!text) {
				return fail('empty instruction');
			}

			const misroutedAnswer = describeMisroutedAnswer(state, checked.ref, text);

			if (misroutedAnswer) {
				return fail(misroutedAnswer);
			}

			if (
				isMisroutedToSetup({
					state,
					ref: checked.ref,
					forwardTo: toolContext.forwardTo ?? null,
					utterance: toolContext.utterance,
				})
			) {
				return fail(
					`Not sent: ${checked.ref} only does crew setup (workspaces, projects, worktrees). Forward it to the session on screen.`,
				);
			}

			return sendRecorded({ state, ref: checked.ref, text, input, name: 'send_to', toolContext });
		}

		case 'switch_view': {
			if (input.ref === null || input.ref === undefined) {
				toolContext.dispatch({ type: 'switch_view', view: { kind: 'grid' } });

				return succeed('showing every session');
			}

			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			toolContext.dispatch({ type: 'switch_view', view: { kind: 'session', ref: checked.ref } });

			return succeed(`showing ${checked.ref}`);
		}

		case 'start_session': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			if (state.sessions[checked.ref]?.status !== 'stopped') {
				return succeed(`${checked.ref} is already ${state.sessions[checked.ref]?.status}`);
			}

			toolContext.dispatch({ type: 'start_session', ref: checked.ref });
			// "Start X" also shows it, as it always has.
			toolContext.dispatch({ type: 'switch_view', view: { kind: 'session', ref: checked.ref } });

			return succeed(`starting ${checked.ref}`);
		}

		case 'stop_session': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			const namedRefs = findNamedRefs(state, toolContext, checked.ref);

			if (namedRefs.length !== 1 || namedRefs[0] !== checked.ref) {
				return fail(
					`Not stopped: the developer did not name exactly one session (${namedRefs.length ? namedRefs.join(', ') : 'none'} fit). Ask which one.`,
				);
			}

			toolContext.dispatch({ type: 'stop_session', ref: checked.ref });

			return succeed(`stopped ${checked.ref}`);
		}

		case 'crew_dev': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			const action = input.action;

			if (action === 'status') {
				return succeed({
					ref: checked.ref,
					servers: state.devServers[checked.ref] ?? [],
					starting: state.devStarting.includes(checked.ref),
				});
			}

			if (action !== 'start' && action !== 'stop' && action !== 'restart') {
				return fail('action must be start, stop, restart or status');
			}

			// The same path as the panel's buttons: Voice OS speaks the servers' verdict itself.
			toolContext.dispatch({ type: `dev_${action}`, ref: checked.ref });

			return succeed(`${action} requested for ${checked.ref}; Voice OS announces the result`);
		}

		case 'answer':
			return answerAsk({ state, input, toolContext });

		case 'queued_message':
			return handleQueuedMessage({ state, input, toolContext });

		case 'interrupt': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			// "Stop listening" is about hands-free, whatever else "stop" means.
			if (toolContext.utterance !== undefined && isAboutHandsFree(toolContext.utterance)) {
				return fail(
					'Not interrupted: the developer spoke about hands-free listening. Use hands_free.',
				);
			}

			// "Stop the refactor and fix the login bug first" says what to do instead: a redirect,
			// which Voice OS confirms before stopping anything.
			if (
				toolContext.utterance !== undefined &&
				SAYS_WHAT_INSTEAD_PATTERN.test(toolContext.utterance)
			) {
				return fail(
					'Not interrupted: they said what to do instead. Forward it with kind redirect: Voice OS asks them whether to stop the work and switch.',
				);
			}

			const isNamed =
				toolContext.utterance === undefined ||
				checked.ref === toolContext.screen ||
				findSessionsNamedIn(state, toolContext.utterance).includes(checked.ref);

			if (!isNamed) {
				return fail(
					`Not interrupted: ${checked.ref} is neither on screen nor named. Ask which one.`,
				);
			}

			const status = state.sessions[checked.ref]?.status;

			if (status !== 'running' && status !== 'blocked') {
				return succeed(`${checked.ref} is not working on anything (${status})`);
			}

			toolContext.dispatch({ type: 'interrupt', ref: checked.ref });

			return succeed(`interrupted ${checked.ref}`);
		}

		case 'mute': {
			toolContext.mute();

			return succeed('quiet: only questions that need the developer are spoken');
		}

		case 'debug_note': {
			const text = typeof input.text === 'string' ? input.text.trim() : '';

			if (!text) {
				return fail('the note is empty: ask what to note');
			}

			toolContext.saveDebugNote({ text, said: toolContext.utterance ?? null });

			return succeed('noted with a snapshot of this moment');
		}

		case 'note': {
			const text = typeof input.text === 'string' ? input.text.trim() : '';

			if (!text) {
				return fail('the note is empty: ask what to note');
			}

			const named = readNoteWorkspace({
				state,
				named: input.workspace,
				screen: toolContext.screen,
			});
			const workspace = named ?? GENERAL_NOTES;

			try {
				toolContext.notes.save({ workspace, text });
			} catch (error) {
				log.error('note not saved', { workspace, error: String(error) });

				return fail('could not save the note: tell the developer it was not kept');
			}

			// A name that matched no workspace lands in the general notes: said, so it is not missed.
			return succeed(
				named === null
					? 'no such workspace: noted in the general notes. Say "Noted in your general notes."'
					: `noted in ${nameNotes(workspace)}'s notes`,
			);
		}

		case 'read_notes': {
			const named = readNoteWorkspace({
				state,
				named: input.workspace,
				screen: toolContext.screen,
			});

			if (named === null) {
				return fail('no workspace by that name has notes: ask which one');
			}

			const workspace = named;
			const notes = toolContext.notes.read(workspace, NOTES_READ_BACK).map(readNoteText);

			if (!notes.length) {
				return succeed(`no notes in ${nameNotes(workspace)} yet`);
			}

			// The model may read them first when asked to have a session work from them: the result says
			// that is the session's job, so the words still reach it.
			return succeed({
				workspace: nameNotes(workspace),
				notes,
				if_asked_for_work:
					"forward the developer's words to the session: it reads the notes file itself",
			});
		}

		case 'hands_free': {
			const direction =
				toolContext.utterance === undefined
					? input.on === true
					: readHandsFreeDirection(toolContext.utterance);

			if (direction === null) {
				return fail('Not changed: the developer did not clearly ask to turn hands-free on or off.');
			}

			const result = toolContext.setHandsFree(direction);

			if (result === 'no_tab') {
				return fail(
					'Not changed: no browser tab to switch. Tell the developer to use the hands-free button.',
				);
			}

			return succeed(
				result === 'changed'
					? `hands-free ${direction ? 'on' : 'off'}; Voice OS said so`
					: `hands-free was already ${direction ? 'on' : 'off'}; Voice OS said so`,
			);
		}

		case 'dev_offer': {
			const devOffer = state.devOffer;

			if (!devOffer) {
				return fail('there is no fix offer to answer');
			}

			if (input.accept !== true) {
				toolContext.dispatch({ type: 'dismiss_dev_offer' });

				return succeed('offer dismissed');
			}

			const offeredRef = devOffer.ref;

			if (!isOfferFresh(devOffer, toolContext.now())) {
				// Final: with tools, the model "recovered" by sending the fix itself.
				return {
					...fail(
						`the fix offer for ${offeredRef} lapsed (over ${formatAge(OFFER_TTL_MS)} old); nothing was sent. Tell the developer it lapsed; send nothing.`,
					),
					isFinal: true,
				};
			}

			toolContext.dispatch({ type: 'fix_dev', ref: offeredRef });

			return succeed(`fixing ${offeredRef}`);
		}

		case 'allow_denied': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			const denial = findLatestDenial(state, checked.ref);

			if (!denial) {
				return fail(`${checked.ref} has nothing blocked`);
			}

			toolContext.dispatch({ type: 'allow_denied', denialId: denial.id });

			return succeed(`allowed ${checked.ref} once`);
		}

		default: {
			return fail(`unknown tool ${name}`);
		}
	}
};
