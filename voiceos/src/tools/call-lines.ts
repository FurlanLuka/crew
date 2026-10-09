import { SWITCH_OFFERED_NOTE } from './announced.js';
import { ASK_WHICH_NOTE, KERNEL_ASKS_WHICH_NOTE } from './send-guard.js';
import { OFFER_ASKED_NOTE } from './activate.js';
import { type ToolCall, type ToolName, MUTATING_TOOLS } from './definitions.js';
import { clipQuoted } from './recent-action.js';
import { isShortEnoughToAnswer } from './send.js';

const SILENT_TOOLS: ToolName[] = [
	'forward',
	'send_to',
	'switch_view',
	'go_back',
	'play_missed',
	'new_session',
	'remove_session',
	'status_update',
	'activate',
	'ignore_words',
	'answer',
	'interrupt',
	'mute',
	'dev_offer',
	'allow_denied',
	'hands_free',
	'open_doc',
];

// read_notes changes nothing, but what it read out is what "the second one" points at next.
// list_sessions too: a question after it ("…Activate one?") is Voice OS's own, and a yes to it must
// never resend the developer's words to a session as if Voice OS had offered to ask it.
const REMEMBERED_TOOLS: ToolName[] = [
	...MUTATING_TOOLS,
	'switch_view',
	'open_doc',
	'read_notes',
	'list_sessions',
];

const describeCallAction = (input: Record<string, unknown>): string => {
	if (typeof input.action === 'string') {
		return ` ${input.action}`;
	}

	if (typeof input.decision === 'string') {
		return ` ${input.decision}`;
	}

	if (typeof input.accept === 'boolean') {
		return ` ${input.accept ? 'accepted' : 'declined'}`;
	}

	if (typeof input.mode === 'string') {
		return ` ${input.mode}`;
	}

	if (typeof input.on === 'boolean') {
		return ` ${input.on ? 'on' : 'off'}`;
	}

	return '';
};

export const describeToolCall = ({ name, input, ok, note }: ToolCall): string | null => {
	// Remembered so a follow-up ("also start it") is not taken as a request to do it again.
	if (!REMEMBERED_TOOLS.includes(name as ToolName)) {
		return null;
	}

	const quotedText = typeof input.text === 'string' ? ` "${clipQuoted(input.text)}"` : '';
	const target =
		name === 'switch_view'
			? ` ${input.active === true ? 'active' : typeof input.ref === 'string' ? input.ref : typeof input.machine === 'string' ? input.machine : 'mission control'}`
			: typeof input.ref === 'string'
				? ` ${input.ref}`
				: '';

	const activated = name === 'activate' && typeof input.name === 'string' ? ` ${input.name}` : '';
	const newName = typeof input.name === 'string' ? input.name.trim() : '';
	// "Call it api work" right after a rename is a new name, not the same call again.
	const renamed = name === 'rename_session' ? (newName ? ` to "${newName}"` : ' cleared') : '';

	return `${name}${describeCallAction(input)}${target}${activated}${renamed}${quotedText}${note ? ` (${note})` : ''}${ok ? '' : ' (failed)'}`;
};

export const isSilentCall = (name: string, input: Record<string, unknown>): boolean => {
	// crew_dev start, stop and restart need no reply: the dev servers announce themselves.
	if (name === 'crew_dev') {
		return input.action !== 'status';
	}

	return SILENT_TOOLS.includes(name as ToolName);
};

export const isAnsweredByForward = (calls: ToolCall[]): boolean => {
	// The session answers what was forwarded to it: words beside it only talk over that answer.
	// A call that failed keeps them, since they explain the failure — except a failed answer: that is
	// the kernel trying both, and the forward is what happened.
	return (
		calls.some((call) => call.name === 'forward' && call.ok) &&
		calls.every((call) => call.ok || call.name === 'answer')
	);
};

const MIN_QUESTION_WORDS = 3;

// "Where am I?" waved off as a greeting, with nothing said: a question of three words or more is
// answered, never met with silence.
const isQuestionWavedOff = ({ reply, calls, utterance }: IsAskingBackParams): boolean =>
	!reply.trim() &&
	calls.length > 0 &&
	calls.every(
		(call) => call.name === 'ignore_words' && call.input.reason === 'greeting or acknowledgement',
	) &&
	/\?\s*$/.test(utterance) &&
	utterance.trim().split(/\s+/).length >= MIN_QUESTION_WORDS;

// Words passed on and nothing else, on a session's screen: Voice OS already says "Sent to X". A switch
// needs no such rule: the kernel says nothing beside one, and an answer it writes there is kept.
const isAcknowledgedInCode = (calls: ToolCall[], forwardTo: string | null): boolean =>
	forwardTo !== null &&
	calls.some((call) => call.name === 'send_to') &&
	calls.every((call) => call.ok && (call.name === 'send_to' || call.name === 'forward'));

// Asking what they meant, not asking which option they want ("which one?" after reading options out).
const CLARIFYING_PATTERN =
	/\b(?:need to clarify|do you mean|did you mean|are you asking|(?:are you|you're) referring to|do you want (?:me|to ask)|which (?:session|agent)|not sure (?:what|which|who)|can you (?:name|say|clarify)|could you (?:say|repeat|clarify)|is (?:this|that) for)\b/i;

// "Should I forward that to it?": offering to pass the developer's words on is asking back too —
// not "should I send it the next step?", an offer of new work.
const OFFER_TO_PASS_ON_PATTERN =
	/\b(?:should I|(?:do you )?want me to) (?:forward|send|pass) (?:that|this|it|them)(?: on| along)?(?:\s+to\b|\s*\?)/i;

// Relaying a session's own question ("It asks: did you mean staging?") is an answer, not asking back.
const RELAYED_QUESTION_PATTERN =
	/\b(?:it|the session|claude|[\w-]+\/[\w-]+) (?:asks|is asking|wants to know)\b|\basks:/i;

export interface IsAskingBackParams {
	reply: string;
	calls: ToolCall[];
	// The session on screen, when there is one.
	forwardTo: string | null;
	utterance: string;
	// Sessions the words name: naming another one, or two, makes "which one?" a fair question.
	namedRefs: string[];
}

// The tools a turn may have used and still ask back about the session's work.
const ASK_BACK_TOOLS: ToolName[] = [
	'read_state',
	'read_history',
	'ignore_words',
	'send_to',
	'answer',
];

export const isAskingBack = ({
	reply,
	calls,
	forwardTo,
	utterance,
	namedRefs,
}: IsAskingBackParams): boolean => {
	// On a session screen the words are that session's: asking the developer what they meant only
	// loops ("crew/main or Voice OS?" — "Yes."). The session can ask back itself. A bare "yes" is
	// the exception: when several things wait, "which one?" is the right answer, never a forward.
	const namesAnother = namedRefs.some((ref) => ref !== forwardTo) || namedRefs.length > 1;

	return (
		forwardTo !== null &&
		!isShortEnoughToAnswer(utterance) &&
		!namesAnother &&
		reply.trim().endsWith('?') &&
		(CLARIFYING_PATTERN.test(reply) || OFFER_TO_PASS_ON_PATTERN.test(reply)) &&
		!RELAYED_QUESTION_PATTERN.test(reply) &&
		// A forward that failed ("already sent") explains itself: never send the raw words again.
		!calls.some((call) => call.name === 'forward') &&
		// The guard itself said to ask which session.
		!calls.some((call) => call.note === KERNEL_ASKS_WHICH_NOTE) &&
		// Only after reading or trying to reach a session: any other tool, failed or not ("activate
		// scheduler" → "Which one?", a listening change it could not tell), was a command for Voice
		// OS, and its asking back is about that command.
		calls.every((call) => ASK_BACK_TOOLS.includes(call.name as ToolName)) &&
		!calls.some((call) => call.ok && MUTATING_TOOLS.includes(call.name as ToolName))
	);
};

// The turn only read the session on screen: whatever it said from that read was the session's work.
export const isReadOnlyOfScreen = (
	calls: ToolCall[],
	forwardTo: string | null | undefined,
): boolean =>
	Boolean(forwardTo) &&
	calls.length > 0 &&
	calls.every((call) => call.ok && call.name === 'read_state' && call.input.ref === forwardTo);

export type TurnEnding =
	| { kind: 'forward_utterance' }
	| { kind: 'drop_reply' }
	| { kind: 'answer_now'; reason: 'final' | 'empty' }
	| { kind: 'keep' };

export interface DecideEndingParams extends IsAskingBackParams {
	// The call index where the step that last forwarded began: calls that failed before it were tried
	// and replaced by that forward, so they leave nothing to explain.
	forwardStepStart?: number | null;
	isSilent: boolean;
	// A tool asked for an answer with no more tools.
	mustAnswerNow: boolean;
}

// "Start checkout and tell me what it did last": the activation is said in code ("Activated X. Switch
// there?") and the rest went to it; the model's narration of either would only repeat it.
const isActivatedWithWords = (calls: ToolCall[]): boolean =>
	calls.some((call) => call.ok && call.name === 'activate') &&
	calls.some((call) => call.ok && (call.name === 'send_to' || call.name === 'forward'));

export const decideEnding = ({
	isSilent,
	mustAnswerNow,
	forwardStepStart = null,
	...turn
}: DecideEndingParams): TurnEnding => {
	if (isAskingBack(turn)) {
		return { kind: 'forward_utterance' };
	}

	// On a session's screen Voice OS says "Sent to X" itself (sends.ts), and "Switch to X?" too.
	if (
		isAnsweredByForward(
			forwardStepStart === null ? turn.calls : turn.calls.slice(forwardStepStart),
		) ||
		isAcknowledgedInCode(turn.calls, turn.forwardTo) ||
		turn.calls.some(
			(call) =>
				call.note === SWITCH_OFFERED_NOTE ||
				call.note === ASK_WHICH_NOTE ||
				call.note === OFFER_ASKED_NOTE,
		) ||
		isActivatedWithWords(turn.calls)
	) {
		return { kind: 'drop_reply' };
	}

	if (mustAnswerNow) {
		return { kind: 'answer_now', reason: 'final' };
	}

	if (isQuestionWavedOff(turn)) {
		return { kind: 'answer_now', reason: 'empty' };
	}

	// Silence after tools reads as broken.
	return !turn.reply && !isSilent && turn.calls.length > 0
		? { kind: 'answer_now', reason: 'empty' }
		: { kind: 'keep' };
};
