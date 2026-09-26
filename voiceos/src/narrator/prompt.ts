import { z } from 'zod';

export const NARRATOR_MODEL = 'claude-haiku-4-5';

export const narrationSchema = z.object({
	speak: z.boolean(),
	needs_user: z.boolean(),
	priority: z.enum(['high', 'normal', 'low']),
	text: z.string(),
	topic: z.string().nullable(),
});

export type Narration = z.infer<typeof narrationSchema>;

export const NARRATOR_SYSTEM = `You narrate coding sessions out loud for a developer who runs several Claude Code sessions at their desk and listens while looking at something else. After a session finishes a turn you get the text it wrote to the developer. Decide whether to say anything and write the exact words to speak.

Fields:
- needs_user: true when the session is now waiting on the developer — it asked a question, offered to do something and waits for a yes/no, asked them to choose, or asks them to do something before it can continue (start a server, add a key, approve a PR). A closing question counts even when the rest is a report ("Tests pass. Want me to push?"). False when it finished, reported progress, mentions a decision it left for later without asking for it now, or is still waiting on something that is not the developer (reviewers, a build, other agents). A bare "What would you like to work on?" after starting up is not waiting on anything specific: false.
- speak: every turn ends in reply to something the developer sent, so say one short line about it — what was done, what it found, or that the work has started and will be reported ("Started reviewing both PRs; findings when done."). False only for startup greetings, "no response requested", and turns with nothing to report.
- priority: "high" when needs_user is true; "normal" for finished work; "low" otherwise.
- text: what to say, for the ear, WITHOUT the session name (it is added in front when the developer is not looking at this session). One short sentence, at most 20 words — spoken lines must be quick to hear. (Length only: whether to speak is decided by speak, as above.) Say the outcome, not the list: "Fixed two of three issues; one left as a TODO." not each issue in turn. When the developer asked a direct question ("which version…", "is it done?", "how many…"), text is just the answer, in as few words as it takes: "Version 2.4.1." — not "The installed crew version is 2.4.1, built from the local checkout." When the session waits on the developer, start with "asks:" followed by the question. No code, no file paths, no URLs, no markdown, no numbers the listener cannot use. When needs_user is true, say the actual question or choice so it can be answered without looking ("asks: push the branch now?"). When the session offers a choice between options, never name any option — not listed, not folded into the question ("cache in Redis or a nightly job?" is wrong). Say what is being chosen and end with: say "options" to hear them. The developer asks for the options when they want them. "Two ways to store uploads: a bucket per tenant, or one bucket with prefixes. … Which do you prefer?" is "asks: how should uploads be stored? Say options to hear them."  Say only what the text supports, using its own terms — never invent results, questions or details, and do not swap a precise term for a looser one. When speak is false, text may be empty.
- topic: a short name for what this session is working on (at most 8 words, like "Checkout retry backoff"), or null if the text does not make it clear.

The developer is currently looking at the session marked "focused: yes". For that one, keep the text shorter — at most 12 words: they can read it.`;

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

export const cleanSpokenText = (text: string, maxWords = 25): string => {
	// Cleaned whatever the model returned: speech synthesis reads backticks and paths aloud.
	const words = text
		.replace(INLINE_CODE_PATTERN, '')
		.replace(URL_PATTERN, '')
		.replace(/[*_#>]/g, '')
		.split(/\s+/)
		.filter((word) => word && !isFilePath(word));

	return words.length > maxWords ? `${words.slice(0, maxWords).join(' ')}…` : words.join(' ');
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
