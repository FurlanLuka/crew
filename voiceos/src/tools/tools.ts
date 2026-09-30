import {
	isOfferFresh,
	OFFER_TTL_MS,
	type Action,
	type LastSpokenSend,
	type PendingAsk,
	type State,
	isListenMode,
	type ListenMode,
} from '../shared/protocol.js';
import { formatAge } from '../state/working.js';
import { normalizeUtterance } from '../shared/spoken.js';
import {
	chooseSentWords,
	describeMisroutedAnswer,
	isMisroutedToSetup,
	isWholeSend,
	sendText,
	type SentWords,
} from './send.js';
import { isAboutHandsFree, readListenMode, type HandsFreeResult } from './hands-free.js';
import { answerAsk } from './answer.js';
import { pinSession } from './pin.js';
import { askTarget, decideNotificationReply } from './notification-reply.js';
import { renameSession } from './rename.js';
import { handleQueuedMessage } from './queued.js';
import { findDocToOpen, type OpenUrl } from './docs.js';
import type { HistoryQuery } from '../memory/journal.js';
import type { DebugNoteWords } from '../memory/debug-notes.js';
import type { NotesStore } from '../memory/notes.js';
import { GENERAL_NOTES, nameNotes, readNoteText, readWorkspace } from '../shared/notes.js';
import { createLogger } from '../log.js';
import { normalizeName } from '../router/refs.js';
import { hasOfferedSwitch, isNamedIn, refuseAnnouncedOnly } from './announced.js';
import type { ToolName } from './definitions.js';
import { findNamedRefs, findSessionsNamedIn } from './session-naming.js';
import { describeSession, findLatestDenial } from './session-view.js';
import {
	describeMachineSwitch,
	findMachine,
	findMachineSaid,
	listMachineNames,
	onMachine,
} from './machines.js';
import { HOME_VIEW, currentMachine, readMachineTitle } from '../shared/machines.js';
import { LOCAL_MACHINE, readMachine, splitRef } from '../shared/machine-ref.js';
import { type ToolResult, fail, succeed, checkRef } from './results.js';

const MIN_REQUEST_WORDS = 4;
const log = createLogger('tools');

const NOTES_READ_BACK = 10;
const DEBUG_NOTE_SAVED = 'Debug note saved.';

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

// "Start it and tell me what you did last", "start checkout, then run the tests", "Start it. What…?":
// more than a start. "And open it" is what starting does anyway. Whether the rest is for the session
// (not "and bring up its servers", "and store-front") is the model's call: the hint only asks.
const START_THEN_MORE_PATTERN =
	/\bstart\b[^.?!]*?(?:,?\s+(?:and\s+then|and|then)\s+(?:also\s+)?(?!(?:then\b|(?:open|show)\s+(?:it|them|that)\b))\w+|[.?!]\s+\S)/i;

// The whole utterance is the command: "make the tests quiet" or a long request that ends "…just be
// silent, okay?" is words for a session, and muting on it swallowed what came after.
const MUTE_REQUEST_PATTERN =
	/^(?:(?:hey|okay|ok) )?(?:voice ?os )?(?:(?:okay|ok) )?(?:please )?(?:mute|be quiet|quiet|shut up|stop talking|shush|hush|silence|be silent|quiet please)(?: please)?(?: voice ?os)?(?: please)?$/;

export const isMuteRequest = (utterance: string | undefined): boolean =>
	// Typed or replayed without words: the tool call is the only word there is.
	utterance === undefined ||
	MUTE_REQUEST_PATTERN.test(
		normalizeUtterance(utterance)
			.replace(/[,.!?;:]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
	);

export const saysMoreThanStart = (utterance: string | undefined): boolean =>
	utterance !== undefined && START_THEN_MORE_PATTERN.test(utterance.trim());

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
	setListenMode: (mode: ListenMode) => HandsFreeResult;
	// Bound to the tab the words came from: opens a doc there. false when no tab took it.
	openUrl: OpenUrl;
	dispatch: (action: Action) => void;
	now: () => number;
	readHistory: (query: HistoryQuery) => HistoryEntry[];
}

interface ChooseWordsForParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
}

const chooseWordsFor = ({ state, input, toolContext }: ChooseWordsForParams): SentWords => {
	const utterance = toolContext.utterance;

	return chooseSentWords({
		utterance,
		part: typeof input.text === 'string' ? input.text : undefined,
		earlier: toolContext.recentUtterances ?? [],
		isWhole: utterance
			? isWholeSend({
					state,
					utterance,
					isOnlySend: (toolContext.actionsInTurn ?? 1) <= 1,
				})
			: false,
	});
};

interface SendRecordedParams {
	state: State;
	ref: string;
	// The words chosen for this session (chooseWordsFor).
	words: SentWords;
	input: Record<string, unknown>;
	name: 'forward' | 'send_to';
	toolContext: ToolContext;
}

const sendRecorded = ({
	state,
	ref,
	words,
	input,
	name,
	toolContext,
}: SendRecordedParams): ToolResult => {
	// These words finish the sentence the previous ones began: the session gets it whole, joined as
	// said, and the reducer replaces the first half with it.
	const previous = toolContext.recentUtterances?.at(-1)?.trim();
	const isContinuation =
		input.continues === true && Boolean(previous) && words.source !== 'earlier';
	const text = isContinuation ? `${previous} ${words.text}` : words.text;

	log.info('words chosen', { ref, source: words.source, continues: isContinuation });

	const result = sendText({
		state,
		ref,
		text,
		kind: input.kind,
		...(isContinuation ? { continues: { rest: words.text } } : {}),
		toolContext,
	});

	// The voice log records what the session got, not what the model wrote (often nothing).
	const { ref: _named, ...unaddressed } = input;
	const recorded = name === 'forward' ? { ...unaddressed, text } : { ...input, text };

	return { ...result, recordAs: { name, input: recorded } };
};

// "checkout api", never just "checkout": a word of a workspace's name is also a word of the work.
const isWorkspaceSaidInFull = (ref: string, utterance: string): boolean => {
	const plain = ` ${utterance
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()} `;

	return plain.includes(` ${splitRef(ref).workspace.replace(/-/g, ' ')} `);
};

// A machine the developer named with the session wins over the one a bare name resolved to:
// "crew main on my Mac" while inside Personal is this Mac's crew main, not Personal's.
const scopeToMachine = (
	state: State,
	ref: string,
	machine: unknown,
	toolContext: ToolContext,
): string => {
	const wanted =
		(typeof machine === 'string' && machine.trim() ? findMachine(state, machine) : null) ??
		findMachineSaid(state, toolContext.utterance);

	return (wanted && onMachine(state, ref, wanted)) || ref;
};

interface RefuseOtherMachineParams {
	state: State;
	ref: string;
	toolContext: ToolContext;
}

// A session on another machine than the one the developer is in is acted on only when they named
// it: a bare "start the cutgrid session" means this machine's, never a same-looking one elsewhere.
const refuseOtherMachine = ({
	state,
	ref,
	toolContext,
}: RefuseOtherMachineParams): ToolResult | null => {
	const here = currentMachine(state);

	if (!here || readMachine(ref) === here || toolContext.utterance === undefined) {
		return null;
	}

	if (
		findSessionsNamedIn(state, toolContext.utterance).includes(ref) ||
		findMachineSaid(state, toolContext.utterance) === readMachine(ref)
	) {
		return null;
	}

	const onThisMachine = state.order.filter((candidate) => readMachine(candidate) === here);

	return fail(
		`${ref} is on ${readMachineTitle(state, readMachine(ref))}, and the developer is in ${readMachineTitle(state, here)}. Its sessions: ${onThisMachine.join(', ')}. Pick from those, or ask which one.`,
	);
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

			const words = chooseWordsFor({ state, input, toolContext });

			if (!words.text) {
				return fail('empty text');
			}

			const misroutedAnswer = describeMisroutedAnswer(state, target, words.text);

			if (misroutedAnswer) {
				return fail(misroutedAnswer);
			}

			return sendRecorded({ state, ref: target, words, input, name: 'forward', toolContext });
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

			if (!checked.ok) {
				return fail(checked.error);
			}

			const held = state.sessions[checked.ref]?.heldLine;
			// Asked about by name ("how's crew research doing?"): the developer now hears its update, so
			// it does not replay when they switch there. Read for any other reason, it stays held.
			const isAskedAbout = isNamedIn({ state, ref: checked.ref, utterance: toolContext.utterance });

			if (held?.kind === 'line' && isAskedAbout) {
				toolContext.dispatch({ type: 'held_line_heard', ref: checked.ref, id: held.id });
			}

			return succeed(describeSession({ state, ref: checked.ref, isDetailed: true, now }));
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

			// A sentence cut by a pause goes where its first half went, the session on screen, whatever it
			// mentions ("…slow on the checkout worker?" is not for checkout) unless that session is named.
			const screen = toolContext.forwardTo;
			const isContinuationElsewhere =
				input.continues === true &&
				Boolean(screen && state.sessions[screen]) &&
				screen !== checked.ref &&
				!isWorkspaceSaidInFull(checked.ref, toolContext.utterance ?? '');
			const ref = isContinuationElsewhere && screen ? screen : checked.ref;

			if (isContinuationElsewhere) {
				log.info('continuation kept on the screen', { named: checked.ref, to: ref });
			}

			const words = chooseWordsFor({ state, input, toolContext });

			if (!words.text) {
				return fail('empty instruction');
			}

			const misroutedAnswer = describeMisroutedAnswer(state, ref, words.text);

			if (misroutedAnswer) {
				return fail(misroutedAnswer);
			}

			if (
				isMisroutedToSetup({
					state,
					ref,
					forwardTo: toolContext.forwardTo ?? null,
					utterance: toolContext.utterance,
				})
			) {
				return fail(
					`Not sent: ${ref} only does crew setup (workspaces, projects, worktrees). Forward it to the session on screen.`,
				);
			}

			return sendRecorded({
				state,
				ref,
				words,
				input,
				name: isContinuationElsewhere ? 'forward' : 'send_to',
				toolContext,
			});
		}

		case 'switch_view': {
			// "Go to pinned": the pins are one view across machines, so a ref or machine beside it means nothing.
			if (input.pinned === true) {
				toolContext.dispatch({ type: 'switch_view', view: { kind: 'pinned' } });

				return succeed('showing Pinned');
			}

			if (input.ref === null || input.ref === undefined) {
				if (typeof input.machine === 'string' && input.machine.trim()) {
					const machine = findMachine(state, input.machine);

					if (!machine) {
						return fail(
							`No machine called ${input.machine}. Machines: ${listMachineNames(state)}.`,
						);
					}

					toolContext.dispatch({ type: 'switch_view', view: { kind: 'grid', machine } });

					return succeed(describeMachineSwitch(state, machine));
				}

				toolContext.dispatch({ type: 'switch_view', view: HOME_VIEW });

				return succeed('showing Mission Control');
			}

			const found = checkRef(state, input.ref);
			const checked = found.ok
				? { ...found, ref: scopeToMachine(state, found.ref, input.machine, toolContext) }
				: found;

			if (!checked.ok) {
				// "Switch to personal server": a machine named where a session was expected is that machine.
				const machine = findMachine(state, String(input.ref));

				if (machine) {
					toolContext.dispatch({ type: 'switch_view', view: { kind: 'grid', machine } });

					return succeed(describeMachineSwitch(state, machine));
				}

				return fail(checked.error);
			}

			// A session whose question was only announced is opened when the developer names it, or
			// after they said yes to "Switch to …?": never on a bare "yes" or "what's waiting?".
			const refused = hasOfferedSwitch(state, checked.ref, toolContext.now())
				? null
				: refuseAnnouncedOnly({ state, ref: checked.ref, toolContext, what: 'switched' });

			if (refused) {
				return refused;
			}

			const reply = decideNotificationReply({ state, ref: checked.ref, toolContext });

			if (reply.kind === 'refuse') {
				return fail(reply.why);
			}

			const skipHeld = input.skip_held === true || reply.kind === 'stale_held';

			toolContext.dispatch({
				type: 'switch_view',
				view: { kind: 'session', ref: checked.ref },
				...(skipHeld ? { skipHeld: true as const } : {}),
			});

			return succeed(
				reply.kind === 'stale_held'
					? `showing ${checked.ref}. Its held update is older than five minutes and was not replayed: send_to it with the developer's question.`
					: `showing ${checked.ref}`,
			);
		}

		case 'ask_target':
			return askTarget({ state, input, toolContext });

		case 'start_session': {
			const found = checkRef(state, input.ref);

			if (!found.ok) {
				return fail(found.error);
			}

			const checked = { ...found, ref: scopeToMachine(state, found.ref, undefined, toolContext) };

			const elsewhere = refuseOtherMachine({ state, ref: checked.ref, toolContext });

			if (elsewhere) {
				return elsewhere;
			}

			const isStopped = state.sessions[checked.ref]?.status === 'stopped';

			if (isStopped) {
				toolContext.dispatch({ type: 'start_session', ref: checked.ref });
				// "Start X" also shows it, as it always has.
				toolContext.dispatch({ type: 'switch_view', view: { kind: 'session', ref: checked.ref } });
			}

			const started = isStopped
				? `starting ${checked.ref}`
				: `${checked.ref} is already ${state.sessions[checked.ref]?.status}`;

			// "Start it and tell me what you did last": the start alone never gives the session the rest —
			// unless the words already went, or name another session ("start checkout and store-front").
			const namesAnother =
				toolContext.utterance !== undefined &&
				findSessionsNamedIn(state, toolContext.utterance).some((named) => named !== checked.ref);

			if (
				saysMoreThanStart(toolContext.utterance) &&
				!namesAnother &&
				!toolContext.sentTo?.has(checked.ref)
			) {
				// forward reaches only the session on screen: from elsewhere it is send_to.
				const how =
					toolContext.forwardTo === checked.ref
						? 'forward that part'
						: `send_to ${checked.ref} that part`;
				log.info('start with more', { ref: checked.ref });

				return succeed(
					`${started}. If the developer also asked ${checked.ref} something (not a command for Voice OS, like its dev servers), ${how} now — it waits until the session is up.`,
				);
			}

			return succeed(started);
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

		case 'go_back':
			toolContext.dispatch({ type: 'go_back' });

			return succeed('went back: Voice OS says where to');

		case 'pin_session':
			return pinSession({
				state,
				input,
				toolContext,
				scope: (ref) => scopeToMachine(state, ref, undefined, toolContext),
			});

		case 'rename_session':
			return renameSession({
				state,
				input,
				toolContext,
				scope: (ref) => scopeToMachine(state, ref, undefined, toolContext),
			});

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
			if (!isMuteRequest(toolContext.utterance)) {
				return fail('not a mute request; do nothing more');
			}

			toolContext.mute();

			return succeed('quiet: only questions that need the developer are spoken');
		}

		case 'debug_note': {
			const text = typeof input.text === 'string' ? input.text.trim() : '';

			if (!text) {
				return fail('the note is empty: ask what to note');
			}

			toolContext.saveDebugNote({ text, said: toolContext.utterance ?? null });

			return {
				...succeed('debug note saved with a snapshot of this moment. Say "Debug note saved."'),
				reply: DEBUG_NOTE_SAVED,
			};
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

		case 'open_doc': {
			const named = typeof input.ref === 'string' ? checkRef(state, input.ref) : null;

			if (named && !named.ok) {
				return fail(named.error);
			}

			const ref = named?.ok ? named.ref : toolContext.screen;

			if (!ref) {
				return fail("No session on screen: ask which session's doc to open.");
			}

			const title = typeof input.title === 'string' && input.title.trim() ? input.title : null;
			const doc = findDocToOpen({ state, ref, title });

			if (!doc) {
				return fail(
					title
						? `${ref} has no doc titled like "${title}": say which docs it has.`
						: `${ref} has made no doc yet: tell the developer.`,
				);
			}

			if (!toolContext.openUrl(doc.url, doc.title)) {
				return fail(
					'No browser tab to open it in: tell the developer to click the doc card in the session.',
				);
			}

			log.info('doc opened', { ref, title: doc.title });

			return succeed(`opened "${doc.title}" in the developer's browser`);
		}

		case 'rename_machine': {
			const machine = typeof input.machine === 'string' ? findMachine(state, input.machine) : null;
			const name = typeof input.name === 'string' ? input.name.trim() : '';

			if (!machine || machine === LOCAL_MACHINE) {
				return fail(
					`No other machine called ${String(input.machine)}. Machines: ${listMachineNames(state)}.`,
				);
			}

			if (!name) {
				return fail('No new name was given.');
			}

			toolContext.dispatch({ type: 'rename_machine', id: machine, name });

			return succeed(`renamed to ${name}`);
		}

		case 'hands_free': {
			const mode =
				toolContext.utterance === undefined
					? // Without the developer's words (typed tests, replays) the model's choice is taken.
						isListenMode(input.mode)
						? input.mode
						: null
					: readListenMode(toolContext.utterance);

			if (mode === null) {
				return fail(
					'Not changed: the developer did not clearly ask for push to talk, on demand or hands-free.',
				);
			}

			const result = toolContext.setListenMode(mode);

			if (result === 'no_tab') {
				return fail(
					'Not changed: no browser tab to switch. Tell the developer to use the listening menu.',
				);
			}

			return succeed(
				result === 'changed'
					? `listening is now ${mode}; Voice OS said so`
					: `listening was already ${mode}; Voice OS said so`,
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
