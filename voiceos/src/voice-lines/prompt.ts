// The small lines Voice OS words with Haiku: its follow-up on what it just did ("Sent to checkout.
// Switch there?"). Pure: the prompt, the message, and the rules a worded line must keep — one that
// breaks a rule is never said; the fixed line is.
import { type FollowUpFacts, listFollowUpLabels, offersSwitch } from '../shared/follow-up.js';
import { endsInQuestion } from '../shared/spoken.js';
import { countSpokenWords } from '../state/helpers.js';
import { findWakePhrase } from '../speech/wake.js';

// A few words, fast: Haiku. Its latency is what the developer waits through.
export const VOICE_LINES_MODEL = 'claude-haiku-4-5';

// Past this a line stops being a quick word; the prompt aims well under it.
export const MAX_LINE_WORDS = 25;

export interface FollowUpInput {
	facts: FollowUpFacts;
	// The line said when no worded one is ready, and what the worded one must mean.
	fixedText: string;
	// The instant acknowledgement said in this turn ("Okay."), so the line does not open with it again.
	lastAck: string | null;
}

export const FOLLOW_UP_SYSTEM = `You word one short line that Voice OS, a voice assistant for coding sessions, says aloud about something it just did for a developer. The developer talks to it while coding and hears the line, so it should sound like a person answering, not a status message. You get the facts and the plain line Voice OS would say otherwise. Say the same thing once, in your own words.

Rules:
- Say only what the facts say. Never add what the session will do next, how long it takes, or any result.
- Every session name given in quotes is said word for word, early in the line.
- When the facts say a switch is offered, end with one short question asking whether to switch there. Otherwise ask nothing: no question mark anywhere.
- When the facts say not to name the session, name none.
- Do not open with the words Voice OS just said ("just said"), and do not repeat them.
- At most 15 words. Plain words only: no tags, no brackets, no quotes, no emoji, never the words "Voice OS".

Reply with the line alone.`;

const quote = (labels: string[]): string => labels.map((label) => `"${label}"`).join(', ');

const describeFacts = (facts: FollowUpFacts): string => {
	switch (facts.kind) {
		case 'sent':
			return `The developer's words were passed to the session ${quote([facts.label])}.`;
		case 'queued':
			return `The developer's words wait until the session finishes its current work. Do not name the session (${quote([facts.label])}): its name is added in front when needed.`;
		case 'switching':
			return `Voice OS is switching the screen to ${quote([facts.label])}.`;
		case 'back':
			return [
				`Voice OS went back to ${quote([facts.label])}.`,
				...(facts.skipped.length > 0
					? [`It passed over ${quote(facts.skipped)}: they stopped.`]
					: []),
			].join(' ');
		case 'activated':
			return [
				`Voice OS activated the session ${quote([facts.label])}: it starts up now.`,
				...(facts.hasWaitingWords ? ["The developer's words go to it once it is up."] : []),
			].join(' ');
	}
};

export const buildFollowUpMessage = ({ facts, fixedText, lastAck }: FollowUpInput): string =>
	[
		`facts: ${describeFacts(facts)}`,
		`switch offered: ${offersSwitch(facts) ? 'yes' : 'no'}`,
		`plain line: ${fixedText}`,
		`just said: ${lastAck ?? '(nothing)'}`,
	].join('\n');

// Words alone, lower case: "Store front, main" and "store front main" name the same session.
const toWords = (text: string): string =>
	` ${text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}']+/gu, ' ')
		.trim()} `;

// The rules every worded line keeps, whatever it says.
const findLineProblem = (line: string): string | null => {
	if (!line) {
		return 'empty';
	}

	// Soniox reads an unknown tag aloud, and in a short line a known one can swallow the words after it.
	if (/[[\]<>]/.test(line)) {
		return 'tags';
	}

	if (findWakePhrase(line) !== null) {
		return 'wake word';
	}

	return countSpokenWords(line) > MAX_LINE_WORDS ? 'too long' : null;
};

// Why a worded follow-up is not said (the fixed line is), or null when it keeps every rule.
export const findFollowUpProblem = (line: string, facts: FollowUpFacts): string | null => {
	const problem = findLineProblem(line);

	if (problem) {
		return problem;
	}

	const words = toWords(line);

	if (listFollowUpLabels(facts).some((label) => !words.includes(toWords(label)))) {
		return 'label';
	}

	// Its name goes in front in code when the session is off screen: said here too, it is heard twice.
	if (facts.kind === 'queued' && words.includes(toWords(facts.label))) {
		return 'named';
	}

	// The open offer is what a bare "yes" answers: the line asks it, or asks nothing.
	if (offersSwitch(facts)) {
		return endsInQuestion(line) ? null : 'question missing';
	}

	return line.includes('?') ? 'question not offered' : null;
};

// A model's reply as a line: its own quotes and surrounding space come off.
// The label reaches the model in quotes, and it keeps them ('Sent to "checkout, main"'): a quote is
// never spoken, so every double quote goes, not only the ones around the line.
export const cleanWordedLine = (text: string): string =>
	text
		.replace(/["“”]/g, '')
		.trim()
		.replace(/^'+|'+$/g, '')
		.trim();
