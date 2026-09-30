// The kernel's view of an off-screen conversation: one line and its rules, only while there is one,
// so ordinary turns read (and cost) exactly what they did.
import type { State } from '../shared/protocol.js';
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
