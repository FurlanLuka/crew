// The kernel's view of an off-screen conversation: one line and its rules, only while there is one,
// so ordinary turns read (and cost) exactly what they did.
import type { SpokenLine, State } from '../shared/protocol.js';
import { readSubject } from '../state/exchange.js';
import { formatAge } from '../state/working.js';
import { readLineRefs } from '../tools/asked-aloud.js';

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

interface DescribeNotificationLinesParams {
	heardBefore: SpokenLine[];
	nameRef: (ref: string) => string;
}

// Only when a notification was just heard: then how a reply to it is routed.
export const describeNotificationLines = ({
	heardBefore,
	nameRef,
}: DescribeNotificationLinesParams): string[] => {
	// "checkout needs you: …", the meanwhile line: Voice OS's notifications, not a session's own line.
	const notifications = heardBefore.filter((line) => line.isUpdate === true);
	const newest = notifications.at(-1);
	const refs = newest ? readLineRefs(newest) : [];

	// The meanwhile line named several: a reply names one of them, or is asked about, never guessed.
	if (refs.length > 1) {
		return [
			`Replying to the meanwhile line, which named ${refs.map(nameRef).join(' and ')}: words that name one of them are for it (send_to, or switch_view to hear it). "Okay", "thanks" → ignore_words. Anything else that could be for either → ask in a few words which one ("For ${nameRef(refs[0]!)} or ${nameRef(refs[1]!)}?"); never pick one yourself.`,
		];
	}

	const ref = refs[0];

	if (!ref) {
		return [];
	}

	const older = notifications
		.slice(0, -1)
		.flatMap(readLineRefs)
		.findLast((other) => other !== ref);

	// Its words, not only whose it was: "what's the current price?" after a line about pricing picks it
	// up without naming the session.
	return [
		`Replying to ${nameRef(ref)}'s notification (the newest one heard, ${quote(newest?.text ?? '')}): a question about what it said — its subject, figures or names — is a reply to it even without naming ${nameRef(ref)}, and is never for the session on screen unless that session's own work is about the same thing. "okay", "got it", "thanks" → ignore_words. "Switch to it" → switch_view ${ref}. A general question about it ("tell me about that", "what happened?") → switch_view ${ref} alone: its update plays there, nothing is sent. A specific question ("what did it change in the redirect?") → switch_view ${ref} with skip_held true and send_to ${ref} with the words. An instruction that follows from its update ("great, push it", "then open a PR") → send_to ${ref} with the words. Words that could be that reply or for the work on screen ("review all of this") → ask_target ${ref}, and nothing else. Words clearly about the work on screen stay there.${older ? ` "No, the other one" → the same for ${older}.` : ''}`,
	];
};
