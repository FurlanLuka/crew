import { type ToolCall, type ToolName, MUTATING_TOOLS } from './definitions.js';
import { isBareAnswer } from './send.js';

const SILENT_TOOLS: ToolName[] = [
	'forward',
	'send_to',
	'switch_view',
	'start_session',
	'ignore_words',
	'answer',
	'interrupt',
	'mute',
	'dev_offer',
	'allow_denied',
	'hands_free',
	'open_doc',
];

const REMEMBERED_TOOLS: ToolName[] = [...MUTATING_TOOLS, 'switch_view', 'open_doc'];
const MAX_QUOTED_CHARS = 120;

const describeCallAction = (name: string, input: Record<string, unknown>): string => {
	// Named either way: "unpin this" right after a pin must read as a change, not the same call again.
	if (name === 'pin_session') {
		return input.unpin === true ? ' unpin' : ' pin';
	}

	if (typeof input.action === 'string') {
		return ` ${input.action}`;
	}

	if (typeof input.decision === 'string') {
		return ` ${input.decision}`;
	}

	if (typeof input.accept === 'boolean') {
		return ` ${input.accept ? 'accepted' : 'declined'}`;
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

	const quotedText =
		typeof input.text === 'string'
			? ` "${input.text.length > MAX_QUOTED_CHARS ? `${input.text.slice(0, MAX_QUOTED_CHARS)}…` : input.text}"`
			: '';
	const target =
		name === 'switch_view'
			? ` ${input.pinned === true ? 'pinned' : typeof input.ref === 'string' ? input.ref : typeof input.machine === 'string' ? input.machine : 'mission control'}`
			: typeof input.ref === 'string'
				? ` ${input.ref}`
				: '';

	const newName = typeof input.name === 'string' ? input.name.trim() : '';
	// "Call it api work" right after a rename is a new name, not the same call again.
	const renamed = name === 'rename_session' ? (newName ? ` to "${newName}"` : ' cleared') : '';

	return `${name}${describeCallAction(name, input)}${target}${renamed}${quotedText}${note ? ` (${note})` : ''}${ok ? '' : ' (failed)'}`;
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
		!isBareAnswer(utterance) &&
		!namesAnother &&
		reply.trim().endsWith('?') &&
		(CLARIFYING_PATTERN.test(reply) || OFFER_TO_PASS_ON_PATTERN.test(reply)) &&
		!RELAYED_QUESTION_PATTERN.test(reply) &&
		// A forward that failed ("already sent") explains itself: never send the raw words again.
		!calls.some((call) => call.name === 'forward') &&
		!calls.some((call) => call.ok && MUTATING_TOOLS.includes(call.name as ToolName))
	);
};

export type TurnEnding =
	| { kind: 'forward_utterance' }
	| { kind: 'drop_reply' }
	| { kind: 'answer_now'; reason: 'final' | 'empty' }
	| { kind: 'keep' };

export interface DecideEndingParams extends IsAskingBackParams {
	isSilent: boolean;
	// A tool asked for an answer with no more tools.
	mustAnswerNow: boolean;
}

export const decideEnding = ({
	isSilent,
	mustAnswerNow,
	...turn
}: DecideEndingParams): TurnEnding => {
	if (isAskingBack(turn)) {
		return { kind: 'forward_utterance' };
	}

	if (isAnsweredByForward(turn.calls)) {
		return { kind: 'drop_reply' };
	}

	if (mustAnswerNow) {
		return { kind: 'answer_now', reason: 'final' };
	}

	// Silence after tools reads as broken.
	return !turn.reply && !isSilent && turn.calls.length > 0
		? { kind: 'answer_now', reason: 'empty' }
		: { kind: 'keep' };
};
