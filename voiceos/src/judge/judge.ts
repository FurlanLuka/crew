// One narrow question about what the developer's words mean, asked of a small model on its own: the
// guards that stop the kernel acting on words it misread, in any language. Only a guard about to act
// asks (an approval, a take-back, a mute, a change of listening, a stop, "For X?", a setup misroute),
// after the code's own language-neutral checks, so a plain forward costs nothing extra.
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../log.js';

const log = createLogger('judge');

const JUDGE_MODEL = 'claude-haiku-4-5';
// Past this the guard falls back to its safe side: a slow check never holds the developer up long.
const JUDGE_TIMEOUT_MS = 3_000;

// Each question with the answers it allows; 'unclear' is always allowed and always the safe side.
const JUDGE_QUESTIONS = {
	approves: {
		ask: 'Do these words say yes to what was asked (yes, go ahead, allow it)? A yes with a condition or more words after it is still a yes.',
		answers: ['yes', 'no'],
	},
	approves_plainly: {
		ask: 'Do these words say yes to what was asked, with no refusal, no "not", no "wait" and no holding back anywhere in them?',
		answers: ['yes', 'no'],
	},
	bare_answer: {
		ask: 'Are these words only a yes or a no (or the like), with nothing else asked or said?',
		answers: ['yes', 'no'],
	},
	refuses: {
		ask: 'Do these words say no, decline, or refuse?',
		answers: ['yes', 'no'],
	},
	take_back: {
		ask: 'Do these words only take back the developer\'s last words ("scratch that", "never mind", "forget it"), with nothing new asked?',
		answers: ['yes', 'no'],
	},
	misrouted: {
		ask: "Do these words say the developer's last words were meant for someone else (another session), not this one?",
		answers: ['yes', 'no'],
	},
	take_back_before: {
		ask: 'Did the developer take something back ("scratch that", "vergiss das") and then say the part named below instead? no when the part is itself what they took back, or when nothing was taken back.',
		answers: ['yes', 'no'],
	},
	mute_only: {
		ask: 'Voice OS talks aloud and was asked to go quiet. What do these words ask for? yes: all of it is for Voice OS itself to be quiet (mute, be quiet, stop talking, be still, hush), nothing else. stop: only a bare "stop", "wait" or "halt" (or a translation), which is about the work, not the voice. no: something else, or quiet plus more.',
		answers: ['yes', 'stop', 'no'],
	},
	says_instead: {
		ask: 'Do these words say what to do instead, beyond just stopping or waiting?',
		answers: ['yes', 'no'],
	},
	about_listening: {
		ask: "Are these words about how Voice OS listens to the developer, its microphone (hands-free, on demand, push to talk, listening on or off)? Muting Voice OS's own voice is not this.",
		answers: ['yes', 'no'],
	},
	listen_mode: {
		ask: "Which way of listening do these words ask for? hands-free: always listening. on-demand: listening for its name. push: push to talk. off: stop listening, or turn hands-free off. unclear: they mute Voice OS's voice, or say nothing about how it listens.",
		answers: ['hands-free', 'on-demand', 'push', 'off'],
	},
	asks_about_options: {
		ask: 'Voice OS asked the developer to choose one of the options named below. Do these words ask something about the options (what one does, how they differ) rather than choose one? A choice said with a questioning voice ("the second?", "Postgres?") is a choice: no.',
		answers: ['yes', 'no'],
	},
	for_setup: {
		ask: "Are these words addressed to Voice OS's setup, or about crew workspaces, projects, worktrees or bindings?",
		answers: ['yes', 'no'],
	},
	this_session: {
		ask: 'Do these words refer to the session on screen with a word like "this" or "current" ("this session", "this one", "diese Sitzung", "ta seja"), rather than by a name?',
		answers: ['yes', 'no'],
	},
	more_than_start: {
		ask: 'The developer asked Voice OS to start (open, run, launch) a coding session. Besides starting it, do these words ask that session to do some work?',
		answers: ['yes', 'no'],
	},
	target_answer: {
		ask: 'Voice OS asked "For <another session>?": whether the developer\'s last words were meant for it. yes: only agrees (yes, ja, that one). no: only declines (no, nein, here, this one). other: anything that is not just a yes or a no — an instruction, a question, new words.',
		answers: ['yes', 'no', 'other'],
	},
} as const;

export type JudgeKey = keyof typeof JUDGE_QUESTIONS;
export type JudgeAnswer<K extends JudgeKey> =
	| (typeof JUDGE_QUESTIONS)[K]['answers'][number]
	| 'unclear';

interface JudgeParams<K extends JudgeKey> {
	key: K;
	utterance: string;
	// What the question is about, when the words need it ("Voice OS asked: For checkout?").
	context?: string;
}

export type Judge = <K extends JudgeKey>(params: JudgeParams<K>) => Promise<JudgeAnswer<K>>;

const JUDGE_SYSTEM =
	'You read what a developer said to Voice OS, a voice assistant for coding sessions, and answer one question about what their words mean. The words may be in any language and come from speech-to-text. Judge the meaning, not the language or the wording. You are not told what came before: judge the words as a reply to what the question describes. Answer unclear only when the words really could mean either.';

interface CreateJudgeParams {
	apiKey: string | null;
	client?: Anthropic;
	timeoutMs?: number;
}

export const createJudge = ({
	apiKey,
	client,
	timeoutMs = JUDGE_TIMEOUT_MS,
}: CreateJudgeParams): Judge => {
	const anthropic = client ?? (apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : null);

	return async ({ key, utterance, context }) => {
		const question = JUDGE_QUESTIONS[key];
		const answers = [...question.answers, 'unclear'];

		if (!anthropic) {
			return 'unclear';
		}

		const startedAt = Date.now();
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeoutMs);

		try {
			const response = await anthropic.messages.create(
				{
					model: JUDGE_MODEL,
					max_tokens: 100,
					temperature: 0,
					system: JUDGE_SYSTEM,
					tools: [
						{
							name: 'verdict',
							description: 'Your answer to the question.',
							input_schema: {
								type: 'object',
								properties: { verdict: { type: 'string', enum: answers } },
								required: ['verdict'],
							},
						},
					],
					tool_choice: { type: 'tool', name: 'verdict' },
					messages: [
						{
							role: 'user',
							content: [
								`Question: ${question.ask}`,
								...(context ? [`Context: ${context}`] : []),
								`The developer said: "${utterance}"`,
							].join('\n'),
						},
					],
				},
				{ signal: abort.signal },
			);
			const block = response.content.find((part) => part.type === 'tool_use');
			const verdict =
				(block?.type === 'tool_use' ? (block.input as { verdict?: unknown }).verdict : null) ??
				'unclear';
			const answer = answers.includes(String(verdict)) ? String(verdict) : 'unclear';

			// The question and its verdict, never the words: they can carry anything.
			log.info('judged', { key, answer, ms: Date.now() - startedAt });

			return answer as JudgeAnswer<typeof key>;
		} catch (error) {
			log.warn('judge failed: safe side', {
				key,
				error: String(error),
				ms: Date.now() - startedAt,
			});

			return 'unclear';
		} finally {
			clearTimeout(timer);
		}
	};
};
