// The kernel's view of an off-screen conversation: one line and its rules, only while there is one,
// so ordinary turns read (and cost) exactly what they did.
import type { SpokenLine, State } from '../shared/protocol.js';
import { readSubject } from '../state/exchange.js';
import { formatAge } from '../state/working.js';

const QUOTE_CHARS = 160;

const quote = (text: string): string =>
	`"${text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}…` : text}"`;

interface DescribeExchangeLinesParams {
	state: State;
	now: number;
	nameRef: (ref: string) => string;
}

export const describeExchangeLines = ({
	state,
	now,
	nameRef,
}: DescribeExchangeLinesParams): string[] => {
	const subject = readSubject(state, now);

	if (!subject) {
		return [];
	}

	const asked = state.sessions[subject]?.requests.at(-1)?.text;
	const answered = state.spoken.findLast((line) => line.ref === subject && line.isAnswer);
	const since = state.exchange ? `${formatAge(now - state.exchange.startedAt)} ago` : 'just now';
	const name = nameRef(subject);

	return [
		`Talking with ${name} (not on screen, since ${since}): ${[
			asked ? `the developer last asked it ${quote(asked)}` : null,
			answered ? `it answered ${quote(answered.text)}` : 'no answer heard yet',
		]
			.filter(Boolean)
			.join('; ')}.`,
		`While talking with ${subject}: words that go on with that conversation, or could be for either, are for ${subject} — send_to it, not forward. Only words clearly about the work on screen go to the screen (forward), and that ends the conversation with ${subject}. "Switch to it" is switch_view to ${subject}. "Who am I talking to?", "where am I?": answer from the Screen line and this one, like "You're on <screen>, talking with <${subject}>."`,
	];
};

// "checkout is done: …", "checkout needs you: …" — Voice OS's notifications, not a session's own line.
const NOTIFICATION_PATTERN = /\b(?:is done|needs you)\b/i;

interface DescribeNotificationLinesParams {
	heardBefore: SpokenLine[];
	nameRef: (ref: string) => string;
}

// Only when a notification was just heard: then how a reply to it is routed.
export const describeNotificationLines = ({
	heardBefore,
	nameRef,
}: DescribeNotificationLinesParams): string[] => {
	const notifications = heardBefore.filter(
		(line) => line.ref !== undefined && NOTIFICATION_PATTERN.test(line.text),
	);
	const newest = notifications.at(-1);

	if (!newest?.ref) {
		return [];
	}

	const ref = newest.ref;
	const older = notifications.slice(0, -1).findLast((line) => line.ref !== ref)?.ref;

	return [
		`Replying to ${nameRef(ref)}'s notification (the newest one heard): "okay", "got it", "thanks" → ignore_words. "Switch to it" → switch_view ${ref}. A general question about it ("tell me about that", "what happened?") → switch_view ${ref} alone: its update plays there, nothing is sent. A specific question ("what did it change in the redirect?") → switch_view ${ref} with skip_held true and send_to ${ref} with the words. Words that could be that reply or for the work on screen ("review all of this") → ask_target ${ref}, and nothing else. Words clearly about the work on screen stay there.${older ? ` "No, the other one" → the same for ${older}.` : ''}`,
	];
};
