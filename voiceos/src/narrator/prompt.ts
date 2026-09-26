import { z } from 'zod';

// Sonnet: it held every narration rule where Haiku slipped, for about a second more per line.
export const NARRATOR_MODEL = 'claude-sonnet-5';

export const narrationSchema = z.object({
	speak: z.boolean(),
	needs_user: z.boolean(),
	priority: z.enum(['high', 'normal', 'low']),
	text: z.string(),
	topic: z.string().nullable(),
});

export type Narration = z.infer<typeof narrationSchema>;

// What the model returns: a direct answer and a choice come apart from text, so code can keep them short.
export const narratorOutputSchema = narrationSchema.extend({
	answer: z.string().nullable(),
	choosing: z.string().nullable(),
});

export type NarratorOutput = z.infer<typeof narratorOutputSchema>;

export const NARRATOR_SYSTEM = `You narrate coding sessions out loud for a developer who runs several Claude Code sessions at their desk and listens while looking at something else. After a session finishes a turn you get the text it wrote to the developer. Decide whether to say anything and write the exact words to speak.

Fields:
- needs_user: true when the session is now waiting on the developer — it asked a question, offered to do something and waits for a yes/no, asked them to choose, or asks them to do something before it can continue (start a server, add a key, approve a PR). A closing question counts even when the rest is a report ("Tests pass. Want me to push?"). False when it finished, reported progress, gave advice about what the developer could do, without asking anything or offering to do it itself ("Squash the history before pushing." or "If you don't want that yet, switch CI to manual." is advice, not a question — "I can switch CI to manual if you want" is an offer), mentions a decision it left for later without asking for it now, or is still waiting on something that is not the developer (reviewers, a build, other agents). A bare "What would you like to work on?" after starting up is not waiting on anything specific: false.
- speak: every turn ends in reply to something the developer sent, so say something about it — what was done, what it found, or that the work has started and will be reported ("Started reviewing both PRs; findings when done."). False only for startup greetings, "no response requested", and turns with nothing to report.
- priority: "high" when needs_user is true; "normal" for finished work; "low" otherwise.
- text: what to say, for the ear, WITHOUT the session name (it is added in front when the developer is not looking at this session). When the session waits on the developer: one short sentence, at most 20 words. Otherwise — a report of what was done or found — a spoken TL;DR in one to three short sentences, about 35 words and never more than 45: the first sentence carries the point on its own, the rest the one or two details the developer needs to act on it — the name, the number, the cause, what it recommends. Reuse the session's own words and terms; it usually opens with a plain summary, so start from that. A line the developer cannot use ("Summary ready.", "PR awaits review.") is wrong: say what the summary says. (Length only: whether to speak is decided by speak, as above.) Say the outcome, not the list — but with what matters: "Fixed two of three issues with tests; the third, routes that skip the audit log, is left as a TODO." not each issue in turn, and not "Fixed two of three issues." When the developer asked a direct question ("which version…", "is it done?", "how many…"), text is just the answer, in as few words as it takes: "Version 2.4.1." — not "The installed crew version is 2.4.1, built from the local checkout." — and the same words go in answer. When the session waits on the developer, start with "asks:" followed by the question. No code, no file paths, no URLs, no markdown, no numbers the listener cannot use. When needs_user is true, say the actual question or choice so it can be answered without looking ("asks: push the branch now?"). When the session offers a choice between options, never name any option — not listed, not folded into the question ("cache in Redis or a nightly job?" is wrong). Say what is being chosen and end with: say "options" to hear them — and put what is being chosen in choosing. The developer asks for the options when they want them. "Two ways to store uploads: a bucket per tenant, or one bucket with prefixes. … Which do you prefer?" is "asks: how should uploads be stored? Say options to hear them."  Say only what the text supports, using its own terms — never invent results, questions or details, and do not swap a precise term for a looser one. When speak is false, text may be empty.
- topic: a short name for what this session is working on (at most 8 words, like "Checkout retry backoff"), or null if the text does not make it clear.
- answer: only when the developer asked a direct question — the answer alone, in as few words as it takes ("Version 2.4.1.", "412 tests.", "Port 51049."): no breakdown, no reason, no second clause. It is spoken instead of text. Otherwise null.
- choosing: only when the session asks the developer to choose between options — what is being chosen, as a short question without any option in it ("how should uploads be stored", not "a bucket per tenant or one bucket?"). It is heard without the reply, so it names what it is about in the developer's terms: "when should Voice OS confirm it passed your words to a session", not "when should the confirmation play". Voice OS speaks "asks: <choosing>? Say options to hear them." instead of text. Otherwise null.

The developer is currently looking at the session marked "focused: yes". For that one, keep the text shorter — one or two sentences, at most 20 words: they can read the rest.`;

export interface NarratorInput {
	label: string;
	text: string;
	asked: string | null;
	focused: boolean;
	topic: string | null;
}

const MAX_INPUT_CHARS = 6000;

export const buildNarratorMessage = ({
	label,
	text,
	asked,
	focused,
	topic,
}: NarratorInput): string => {
	// Cut in the middle: the opening says what was done and the ending carries the question.
	const body =
		text.length > MAX_INPUT_CHARS
			? `${text.slice(0, MAX_INPUT_CHARS / 2)}\n[…]\n${text.slice(-MAX_INPUT_CHARS / 2)}`
			: text;

	return [
		`session: ${label}`,
		`focused: ${focused ? 'yes' : 'no'}`,
		`current topic: ${topic ?? 'none'}`,
		`developer asked: ${asked ? asked.slice(0, 500) : '(unknown)'}`,
		'',
		'session wrote:',
		body,
	].join('\n');
};

const INLINE_CODE_PATTERN = /`[^`]*`/g;
const URL_PATTERN = /https?:\/\/\S+/g;

const isFilePath = (word: string): boolean => {
	// A worktree ref like store-front/main is worth saying; a longer path or a file name is noise.
	const bareWord = word.replace(/[.,;:!?)]+$/, '');

	return (
		bareWord.includes('/') && (bareWord.split('/').length > 2 || /\.[a-z0-9]{1,5}$/i.test(bareWord))
	);
};

export const cleanSpokenText = (text: string, maxWords = 70): string => {
	// Cleaned whatever the model returned: speech synthesis reads backticks and paths aloud.
	const words = text
		.replace(INLINE_CODE_PATTERN, '')
		.replace(URL_PATTERN, '')
		.replace(/[*_#>]/g, '')
		.split(/\s+/)
		.filter((word) => word && !isFilePath(word));

	return words.length > maxWords ? `${words.slice(0, maxWords).join(' ')}…` : words.join(' ');
};

export const composeNarration = ({ answer, choosing, ...narration }: NarratorOutput): Narration => {
	// Built here rather than trusted to text: the model lets options and a second clause slip into its own line.
	const question = choosing?.trim().replace(/[?.!\s]+$/, '');
	const text = question
		? `asks: ${question}? Say options to hear them.`
		: answer?.trim() || narration.text;

	return { ...narration, text: cleanSpokenText(text) };
};

export const createFallbackNarration = ({ text }: NarratorInput): Narration => {
	// Used when the model call fails: never silent about a question, never chatty otherwise.
	const trimmed = text.trim();
	const lastSentence =
		trimmed
			.split(/(?<=[.!?])\s+/)
			.filter(Boolean)
			.at(-1) ?? '';
	const isAsking = /\?\s*$/.test(trimmed);

	return {
		speak: isAsking,
		needs_user: isAsking,
		priority: isAsking ? 'high' : 'low',
		text: isAsking ? cleanSpokenText(`asks: ${lastSentence}`) : '',
		topic: null,
	};
};
