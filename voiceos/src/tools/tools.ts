import { removeChat, startChat } from './chats.js';
import type { RunSetupCommand } from '../crew/api.js';
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
import { normalizeUtterance, toSpokenName } from '../shared/spoken.js';
import {
	chooseSentWords,
	describeMisroutedAnswer,
	describeOfferAnswer,
	isShortEnoughToAnswer,
	isWholeSend,
	readYesToOffer,
	sendText,
	type SentWords,
} from './send.js';
import { type HandsFreeResult, toListenMode } from './hands-free.js';
import { countSpokenWords, readLabel, readScreenRef } from '../state/helpers.js';
import { isDeliverWish } from '../state/delivery.js';
import { answerAsk } from './answer.js';
import {
	activateSession,
	deactivateSession,
	isMoreThanCommand,
	refuseInactive,
} from './activate.js';
import { listSessions } from './list-sessions.js';
import { isActive, listActiveInOrder } from '../shared/active.js';
import { decideNotificationReply } from './notification-reply.js';
import { guardSendTo } from './send-guard.js';
import { findVoiceOsQuestion } from './asked-aloud.js';
import { forwardChosen, sendRecorded } from './forward.js';
import { renameSession } from './rename.js';
import { handleQueuedMessage } from './queued.js';
import { findDocToOpen, type OpenUrl } from './docs.js';
import type { HistoryQuery } from '../memory/journal.js';
import type { DebugNoteWords } from '../memory/debug-notes.js';
import type { Judge } from '../judge/judge.js';
import type { NotesStore } from '../memory/notes.js';
import { GENERAL_NOTES, nameNotes, readNoteText, readWorkspace } from '../shared/notes.js';
import { createLogger } from '../log.js';
import { normalizeName } from '../router/refs.js';
import { isNamedIn, isSwitchOfferedFor, refuseAnnouncedOnly } from './announced.js';
import type { ToolName } from './definitions.js';
import { findSessionsNamedIn, isOwnNameSaid, readNamedInstead } from './session-naming.js';
import { describeSession, findLatestDenial } from './session-view.js';
import {
	describeMachineSwitch,
	findMachine,
	findMachineSaid,
	listMachineNames,
	onMachine,
} from './machines.js';
import { HOME_VIEW } from '../shared/machines.js';
import { LOCAL_MACHINE, splitRef } from '../shared/machine-ref.js';
import { type RefCheck, type ToolResult, fail, succeed, checkRef } from './results.js';

// A request is at least this many words; fewer is a yes, a name or a fragment. Also the instant
// ack's floor (speech/instant-ack.ts).
export const MIN_REQUEST_WORDS = 4;
const log = createLogger('tools');

// A ref that did not check out: an inactive session is asked about ("Activate it?"), anything else
// fails with the reason.
const refuseRef = (
	checked: Extract<RefCheck, { ok: false }>,
	toolContext: ToolContext,
): ToolResult =>
	checked.inactive ? refuseInactive({ ref: checked.inactive, toolContext }) : fail(checked.error);

const readableRef = (checked: RefCheck): RefCheck =>
	!checked.ok && checked.inactive ? { ok: true, ref: checked.inactive } : checked;

const NOTES_READ_BACK = 10;
const DEBUG_NOTE_SAVED = 'Debug note saved.';

interface ReadNoteWorkspaceParams {
	state: State;
	named: unknown;
	screen: string | null | undefined;
}

const readNoteWorkspace = ({ state, named, screen }: ReadNoteWorkspaceParams): string | null => {
	// A workspace the developer named — matched the way session names are ("storefront" is
	// store-front) — else the one on screen; off a session, the general notes. null: the name
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

const MIN_LONG_SPEECH_WORDS = 10;
// "Stop listening" is two words: one is a stop and nothing else.
const MAX_STOP_WORDS = 1;
// "Tiho", "sei still": short enough that only a clear no from the judge keeps it from muting.
const MAX_MUTE_WORDS = 2;
const WORK_UNDER_WAY = 'A coding session is at work right now.';
const ON_SCREEN_READ_RULE =
	'This is the session on screen. A question about its work, status or progress — "status", even said alone, "how far are you?", "what\'s going on here?" — is answered by its own Claude: forward the words with kind question, and say nothing. Answer from this only a read-back ("what did it say?"), what it waits on, its options or its dev servers.';

const applyListenMode = (toolContext: ToolContext, mode: ListenMode | null): ToolResult => {
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

	// Remembered as the mode applied, which the words chose, not the one the model guessed; a mute
	// that turned out to be about listening is remembered as the listening change it was.
	return {
		...succeed(
			result === 'changed'
				? `listening is now ${mode}; Voice OS said so`
				: `listening was already ${mode}; Voice OS said so`,
		),
		recordAs: { name: 'hands_free', input: { mode } },
	};
};

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
	// The developer's last words on this screen when Voice OS answered them only with a question of its
	// own ("Want me to ask it?"): a plain yes now means those words, not "yes".
	askedBack?: string;
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
	// What the developer's words mean, in any language (judge/judge.ts says who asks).
	judge: Judge;
	// The developer's own notes, per workspace.
	notes: NotesStore;
	// Calls that change something in this turn so far, this step's included: more than one splits the words.
	actionsInTurn?: number;
	// The tools that already ran ok this turn: words a Voice OS command took are not forwarded too.
	doneInTurn?: string[];
	// Sessions this turn already sent words to: an answer that would send them again does not.
	sentTo?: Set<string>;
	// The session a switch or go back took the developer to this turn, words left for it: forwardTo
	// stays the old screen, so a send there is the developer's, not a guess.
	movedTo?: string;
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
	// Runs crew on a machine (the door Set up uses): plain sessions are made and removed there.
	runCrewOn?: RunSetupCommand;
}

interface ChooseWordsForParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
}

const chooseWordsFor = async ({
	state,
	input,
	toolContext,
}: ChooseWordsForParams): Promise<SentWords> => {
	const utterance = toolContext.utterance;

	// "Want me to ask it?" — "Yes." The model sends the yes, or its own rewording of the question (which
	// the word-for-word rule then drops for the yes): the question as the developer said it is what
	// they agreed to send.
	if (
		toolContext.askedBack &&
		utterance &&
		isShortEnoughToAnswer(utterance) &&
		(await toolContext.judge({ key: 'approves', utterance })) === 'yes'
	) {
		log.info('yes to an offer to ask: its question sent', { chars: toolContext.askedBack.length });

		return { text: toolContext.askedBack, source: 'earlier' };
	}

	return chooseSentWords({
		judge: toolContext.judge,
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

const GO_BACK_TO_WORDS = 8;

// Voice OS asking "what should I call it?" makes a bare name the answer: the judge is told so.
const describeAskedName = (state: State, toolContext: ToolContext): { context?: string } => {
	const asked = findVoiceOsQuestion({
		spoken: state.spoken,
		now: toolContext.now(),
		...(toolContext.heardFrom === undefined ? {} : { heardFrom: toolContext.heardFrom }),
	});

	return asked ? { context: `Voice OS just asked: "${asked.text}"` } : {};
};

interface OpenForTheRestParams {
	ref: string;
	// What Voice OS did, for the judge and the kernel: "switched to crew/main".
	did: string;
	toolContext: ToolContext;
}

// After a switch or a go back, words longer than the command may also ask the session for work. Then
// the turn stays open: the kernel sends that part to where the developer went, and Voice OS says
// "Sent to X". null: the command was all the words asked.
const openForTheRest = async ({
	ref,
	did,
	toolContext,
}: OpenForTheRestParams): Promise<ToolResult | null> => {
	const said = toolContext.utterance;

	if (
		said === undefined ||
		countSpokenWords(said) <= GO_BACK_TO_WORDS ||
		!(await isMoreThanCommand({
			ref,
			toolContext,
			state: toolContext.getState(),
			key: 'more_than_command',
			context: `Voice OS already did: ${did}`,
		}))
	) {
		return null;
	}

	log.info('more than the command: the rest goes there', { ref });
	toolContext.movedTo = ref;

	// send_to, never forward: the session was not on screen when the words were said (a long switch to
	// the screen's own session forwards them before getting here).
	return {
		...succeed(
			`${did}. The developer also asked it something: send_to ${ref} that part (text copied word for word) now.`,
		),
		isOpen: true,
	};
};

export const executeTool = async (
	name: string,
	input: Record<string, unknown>,
	toolContext: ToolContext,
): Promise<ToolResult> => {
	const state = toolContext.getState();

	switch (name as ToolName) {
		case 'forward': {
			const words = await chooseWordsFor({ state, input, toolContext });

			if (!words.text) {
				return fail('empty text');
			}

			return forwardChosen({ words, kind: input.kind, input, toolContext });
		}

		case 'ignore_words': {
			// "Sí." right after "Switch there?" was ignored as an acknowledgement: a bare yes to Voice OS's
			// own offer is never noise, in any language. Only a yes: a bare no changes nothing, and ignoring
			// it is how it stays silent.
			const offer = await readYesToOffer(state, toolContext);

			if (offer) {
				return fail(
					`Not ignored: "${toolContext.utterance}" says yes to Voice OS's ${describeOfferAnswer(offer.kind, offer.ref)}.`,
				);
			}

			// A finished request is never an unfinished thought: "can you, um, close the agent?" and
			// "and can you tell me what's running." were taken for ones. Short ones stay ignorable
			// (speech-to-text punctuates a cut-off "and can you?" too), and so does a lyric or a video.
			const said = (toolContext.utterance ?? '').trim();
			// A sentence that ends (a question mark, a full stop) is finished, in any language.
			// Speech-to-text closes nearly everything with a full stop, so this refuses more than it
			// must: a refusal only costs the kernel a second look, and it can still ignore words that
			// were not said to anyone. Swallowing a request costs the developer the request.
			const isRequest = /[?.!]$/.test(said) && countSpokenWords(said) >= MIN_REQUEST_WORDS;

			// Fragments are a few words ("and can you"); a long stretch of speech is a thought or not
			// for anyone — the developer's own thinking aloud was ignored as "unfinished".
			const isLong = countSpokenWords(said) >= MIN_LONG_SPEECH_WORDS;

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
					listActiveInOrder(state).map((ref) =>
						describeSession({ state, ref, isDetailed: false, now }),
					),
				);
			}

			// Reading needs no running Claude: an inactive session is read from what Voice OS keeps.
			const checked = readableRef(checkRef(state, input.ref));

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

			const described = describeSession({ state, ref: checked.ref, isDetailed: true, now });

			// Read with the answer in hand, "status" was answered from these lines all day instead of by the
			// session that holds the whole conversation: the rule rides with the read.
			return {
				...succeed(
					checked.ref === toolContext.screen
						? { on_screen: ON_SCREEN_READ_RULE, ...described }
						: described,
				),
				// The session as resolved, not as spoken: the reply that reads it back is its news.
				recordAs: { name: 'read_state', input: { ...input, ref: checked.ref } },
			};
		}

		case 'read_history': {
			const limit = Math.min(20, Math.max(1, Number(input.limit) || 5));
			const checked =
				typeof input.ref === 'string' ? readableRef(checkRef(state, input.ref)) : null;

			if (checked && !checked.ok) {
				return fail(checked.error);
			}

			const query = typeof input.query === 'string' && input.query.trim() ? input.query : null;
			const ref = checked?.ok ? checked.ref : null;

			return {
				...succeed(toolContext.readHistory({ ref, query, limit })),
				// As resolved, like read_state's: the reply that reads it back is its news.
				recordAs: { name: 'read_history', input: { ...input, ref } },
			};
		}

		case 'send_to': {
			const found = checkRef(state, input.ref);

			// Words for an inactive session are kept for it: sendRecorded asks to activate it.
			const checked: RefCheck =
				!found.ok && found.inactive ? { ok: true, ref: found.inactive } : found;

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

			const words = await chooseWordsFor({ state, input, toolContext });

			if (!words.text) {
				return fail('empty instruction');
			}

			// A bare yes or no sent as words to a session waiting on a permission or plan answers it: the
			// answer tool, before any question of where the words go.
			const misroutedAnswer = await describeMisroutedAnswer({
				state,
				ref,
				text: words.text,
				judge: toolContext.judge,
			});

			if (misroutedAnswer) {
				return fail(misroutedAnswer);
			}

			const guarded = await guardSendTo({ state, ref, words, toolContext });

			if (guarded === 'screen') {
				const { ref: _named, ...rest } = input;

				return forwardChosen({ words, kind: input.kind, input: rest, toolContext });
			}

			if (guarded) {
				return guarded;
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
			// "Go to active": one view across machines, so a ref or machine beside it means nothing.
			if (input.active === true) {
				toolContext.dispatch({ type: 'switch_view', view: { kind: 'active' } });

				return succeed('showing Active');
			}

			if (input.ref === null || input.ref === undefined) {
				if (typeof input.machine === 'string' && input.machine.trim()) {
					const machine = findMachine(state, input.machine);

					if (!machine) {
						return fail(
							`No machine called ${input.machine}. Machines: ${listMachineNames(state)}.`,
						);
					}

					toolContext.dispatch({ type: 'switch_view', view: { kind: 'activate', machine } });

					return succeed(describeMachineSwitch(state, machine));
				}

				toolContext.dispatch({ type: 'switch_view', view: HOME_VIEW });

				return succeed('showing Active');
			}

			const found = checkRef(state, input.ref);
			const scoped = found.ok
				? { ...found, ref: scopeToMachine(state, found.ref, input.machine, toolContext) }
				: found;
			const namedInstead = scoped.ok
				? readNamedInstead(state, scoped.ref, toolContext.utterance ?? '')
				: null;
			const checked = scoped.ok && namedInstead ? { ...scoped, ref: namedInstead } : scoped;

			if (namedInstead) {
				log.info('switch to the named session', { asked: String(input.ref), ref: namedInstead });
			}

			if (!checked.ok) {
				// "Switch to personal server": a machine named where a session was expected is that machine.
				const machine = findMachine(state, String(input.ref));

				if (machine) {
					toolContext.dispatch({ type: 'switch_view', view: { kind: 'activate', machine } });

					return succeed(describeMachineSwitch(state, machine));
				}

				return checked.inactive
					? refuseInactive({ ref: checked.inactive, toolContext, isSwitch: true })
					: fail(checked.error);
			}

			// Scoped to a machine the developer named, the session there may be one not active.
			if (!isActive(state, checked.ref)) {
				return refuseInactive({ ref: checked.ref, toolContext, isSwitch: true });
			}

			// A session whose question was only announced is opened when the developer asks for it: named,
			// "switch to it" right after its update, or a yes to it. Never to show "what's waiting?".
			const refused = isSwitchOfferedFor(
				state,
				checked.ref,
				toolContext.heardFrom ?? toolContext.now(),
			)
				? null
				: await refuseAnnouncedOnly({ state, ref: checked.ref, toolContext, what: 'switched' });

			if (refused) {
				return refused;
			}

			// Already on screen, so there is nothing to switch: words longer than a "go to X" were for the
			// session. A worktree or machine mentioned in passing ("…I have to do it on my main machine",
			// on crew main's screen) was read as a switch, and the words reached no one.
			const said = toolContext.utterance;

			// Longer words that ask for work mentioning a place ("go to the research folder and check what's
			// in there") were read as a switch too: the judge tells them from a switch, and they go to the
			// session on screen instead.
			const isOnScreen = checked.ref === toolContext.forwardTo;

			if (
				toolContext.forwardTo &&
				said !== undefined &&
				countSpokenWords(said) > GO_BACK_TO_WORDS &&
				(isOnScreen || (await toolContext.judge({ key: 'asks_switch', utterance: said })) === 'no')
			) {
				log.info('words longer than a switch: forwarded', {
					ref: checked.ref,
					onScreen: isOnScreen,
				});
				const words = await chooseWordsFor({ state, input: {}, toolContext });

				return forwardChosen({
					words,
					kind: /\?\s*$/.test(said) ? 'question' : 'instruction',
					toolContext,
				});
			}

			const reply = decideNotificationReply({ state, ref: checked.ref, toolContext });
			const skipHeld = input.skip_held === true || reply.kind === 'stale_held';

			toolContext.dispatch({
				type: 'switch_view',
				view: { kind: 'session', ref: checked.ref },
				...(skipHeld ? { skipHeld: true as const } : {}),
			});

			// "Switch to crew main, ask it to research live voice" switched and dropped the rest (debug
			// note 36): the turn stays open for the kernel to send it there.
			const rest = await openForTheRest({
				ref: checked.ref,
				did: `switched to ${checked.ref}`,
				toolContext,
			});

			if (rest) {
				return rest;
			}

			return succeed(
				reply.kind === 'stale_held'
					? `showing ${checked.ref}. Its held update is older than five minutes and was not replayed: send_to it with the developer's question.`
					: `showing ${checked.ref}`,
			);
		}

		case 'play_missed': {
			// "Yes." to the meanwhile line's "Switch there?" was read as "what did I miss?" again, and the
			// developer heard "Nothing new." (debug note 38).
			const offer = await readYesToOffer(state, toolContext);

			if (offer) {
				log.info('yes to the switch offer: not played', { ref: offer.ref });

				return fail(
					`Not played: "${toolContext.utterance}" says yes to Voice OS's ${describeOfferAnswer(offer.kind, offer.ref)}.`,
				);
			}

			if (state.meanwhile.length === 0) {
				return { ...succeed('nothing is waiting: say "Nothing new."'), reply: 'Nothing new.' };
			}

			toolContext.dispatch({ type: 'play_meanwhile' });

			return succeed(
				`Voice OS says the ${state.meanwhile.length} waiting updates now: say nothing`,
			);
		}

		case 'crew_dev': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return refuseRef(checked, toolContext);
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

		case 'go_back': {
			// "Go back to speak main" names where to (debug note 25): the session named, not the screen
			// before this one. The developer's own name wins when a ref sounds the same.
			const screen = state.view.kind === 'session' ? state.view.ref : null;
			const utterance = toolContext.utterance ?? '';
			// Only a short "go back to X": longer words may name a session for something else.
			const named =
				countSpokenWords(utterance) <= GO_BACK_TO_WORDS
					? findSessionsNamedIn(state, utterance).filter((ref) => ref !== screen)
					: [];
			const target =
				named.length === 1 ? named[0] : named.find((ref) => isOwnNameSaid(state, ref, utterance));

			if (target) {
				log.info('go back to the session named', { ref: target });

				return executeTool('switch_view', { ref: target }, toolContext);
			}

			toolContext.dispatch({ type: 'go_back' });

			// "Let's go back to what we have to do on the lesson types…" went back and dropped the rest
			// (debug note 34): the words are for the session it went back to.
			const landed = readScreenRef(toolContext.getState());
			const rest =
				landed && landed !== screen
					? await openForTheRest({ ref: landed, did: `went back to ${landed}`, toolContext })
					: null;

			return rest ?? succeed('went back: Voice OS says where to');
		}

		case 'activate':
			return activateSession({ state, input, toolContext });

		case 'deactivate':
			return deactivateSession({ state, input, toolContext });

		case 'list_sessions':
			return listSessions(state, input);

		case 'new_session':
			return startChat({ state, input, toolContext });

		case 'remove_session':
			return removeChat({ state, input, toolContext });

		case 'rename_session':
			// A misheard "commit directly to main" came back as a rename to "directly to main": only words
			// that ask to name a session rename one; anything unsure leaves the name alone.
			if (
				toolContext.utterance !== undefined &&
				(await toolContext.judge({
					key: 'asks_rename',
					utterance: toolContext.utterance,
					...describeAskedName(state, toolContext),
				})) !== 'yes'
			) {
				return fail(
					'not a rename: the words do not ask to name a session; nothing renamed. Words for the session on screen: forward them.',
				);
			}

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

			// Nothing runs there: a stop never turns into an offer to start it.
			if (!checked.ok) {
				return checked.inactive
					? {
							...succeed(`${checked.inactive} is not active: nothing runs there`),
							reply: `${toSpokenName(readLabel(state, checked.inactive))} isn't running.`,
						}
					: fail(checked.error);
			}

			// "Stop" alone is only a stop, in any language: the judge is asked only when there is more.
			if (
				toolContext.utterance !== undefined &&
				countSpokenWords(toolContext.utterance) > MAX_STOP_WORDS
			) {
				const [aboutListening, saysInstead] = await Promise.all([
					// Told that work is under way, "can you stop?" reads as that work, not the microphone.
					toolContext.judge({
						key: 'about_listening',
						utterance: toolContext.utterance,
						context: WORK_UNDER_WAY,
					}),
					toolContext.judge({
						key: 'says_instead',
						utterance: toolContext.utterance,
						context: WORK_UNDER_WAY,
					}),
				]);

				// "Stop listening" is about hands-free, whatever else "stop" means.
				if (aboutListening === 'yes') {
					return fail(
						'Not interrupted: the developer spoke about hands-free listening. Use hands_free.',
					);
				}

				// "Stop the refactor and fix the login bug first" says what to do instead: a redirect,
				// which Voice OS confirms before stopping anything.
				if (saysInstead === 'yes') {
					return fail(
						'Not interrupted: they said what to do instead. Forward it with kind redirect: Voice OS asks them whether to stop the work and switch.',
					);
				}
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
			// The whole utterance is the command: "make the tests quiet" or a long request that ends
			// "…just be silent, okay?" is words for a session, and muting on it swallowed what came after.
			// A word or two the kernel took for a mute ("tiho", "sei still") mutes unless the judge hears a
			// bare "stop" (about the work) or something else. Anything longer mutes only on a clear yes.
			const said = toolContext.utterance;
			const verdict =
				said === undefined ? 'yes' : await toolContext.judge({ key: 'mute_only', utterance: said });
			const isShort = said !== undefined && countSpokenWords(said) <= MAX_MUTE_WORDS;
			const isMute = verdict === 'yes' || (isShort && verdict === 'unclear');

			if (said !== undefined && !isMute) {
				if (verdict === 'stop') {
					return fail('not a mute request: a bare stop is about the work; do nothing more');
				}

				// "Stop listening" in another language reached for mute: it is a change of listening, made
				// here, so the model has nothing to explain and a second call to get wrong.
				const [aboutListening, listenMode] = await Promise.all([
					toolContext.judge({ key: 'about_listening', utterance: said }),
					toolContext.judge({ key: 'listen_mode', utterance: said }),
				]);

				if (aboutListening !== 'yes') {
					return fail('not a mute request; do nothing more');
				}

				return applyListenMode(toolContext, toListenMode(listenMode));
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

			// "Show me the kernel prompt" is no doc of the session's: it is something to show, which is
			// work for the session on screen (debug note 26). Asking the developer for a doc name helps nobody.
			if (!doc && ref === toolContext.forwardTo) {
				return fail(
					`${ref} has no doc ${title ? `titled like "${title}"` : 'yet'}: the developer asked the session on screen to show them something. Forward their words to it, as said; never ask what the doc is called.`,
				);
			}

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
			// The words decide the mode, not the kernel: "stop listening" must never turn listening on.
			const mode =
				toolContext.utterance === undefined
					? // Without the developer's words (typed tests, replays) the model's choice is taken.
						isListenMode(input.mode)
						? input.mode
						: null
					: toListenMode(
							await toolContext.judge({ key: 'listen_mode', utterance: toolContext.utterance }),
						);

			return applyListenMode(toolContext, mode);
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
				return refuseRef(checked, toolContext);
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
