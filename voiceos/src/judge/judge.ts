// One narrow question about what the developer's words mean, asked of a small model on its own: the
// guards that stop the kernel acting on words it misread, in any language. Only a guarded action
// asks (an approval, a take-back, a mute, listening), so a plain forward costs nothing extra.
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../log.js';

const log = createLogger('judge');

export const JUDGE_MODEL = 'claude-haiku-4-5';
// Past this the guard falls back to its safe side: a slow check never holds the developer up long.
export const JUDGE_TIMEOUT_MS = 3_000;

// Each question with the answers it allows; 'unclear' is always allowed and always the safe side.
export const JUDGE_QUESTIONS = {
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
		ask: 'Do these words take back something said earlier in them, and then say something else instead?',
		answers: ['yes', 'no'],
	},
	mute_only: {
		ask: 'Is the whole of these words a request for Voice OS to be quiet (mute, stop talking), with nothing else asked?',
		answers: ['yes', 'no'],
	},
	says_instead: {
		ask: 'Do these words say what to do instead, beyond just stopping or waiting?',
		answers: ['yes', 'no'],
	},
	about_listening: {
		ask: 'Are these words about how Voice OS listens (hands-free, on demand, push to talk, listening on or off)?',
		answers: ['yes', 'no'],
	},
	listen_mode: {
		ask: 'Which way of listening do these words ask for?',
		answers: ['hands-free', 'on-demand', 'push', 'off'],
	},
	asks_about_options: {
		ask: 'Do these words ask a question about the options on offer, rather than choose one?',
		answers: ['yes', 'no'],
	},
	debug_note: {
		ask: 'Do these words ask Voice OS to save (add, take, make) a debug note?',
		answers: ['yes', 'no'],
	},
	for_setup: {
		ask: "Are these words addressed to Voice OS's setup, or about crew workspaces, projects, worktrees or bindings?",
		answers: ['yes', 'no'],
	},
	my_notes: {
		ask: "Do these words mention the developer's own notes (their notes, not other notes)?",
		answers: ['yes', 'no'],
	},
	back_reference: {
		ask: 'Do these words point back at something just done or said ("this", "that", "it")?',
		answers: ['yes', 'no'],
	},
	this_session: {
		ask: 'Do these words name "this session", "the current one" or "the one on screen"?',
		answers: ['yes', 'no'],
	},
	more_than_start: {
		ask: 'Besides starting the session, do these words ask it for something more?',
		answers: ['yes', 'no'],
	},
	target_answer: {
		ask: 'Voice OS asked "Is this for <session>?". Do these words answer yes, answer no, or say something else?',
		answers: ['yes', 'no', 'other'],
	},
	delivery: {
		ask: 'The session is busy. Should these words be answered on the side (a quick question), queued after its work, or taken right now instead of its work?',
		answers: ['aside', 'queue', 'now', 'default'],
	},
} as const;

export type JudgeKey = keyof typeof JUDGE_QUESTIONS;
export type JudgeAnswer<K extends JudgeKey> =
	| (typeof JUDGE_QUESTIONS)[K]['answers'][number]
	| 'unclear';

export interface JudgeParams<K extends JudgeKey> {
	key: K;
	utterance: string;
	// What the question is about, when the words need it ("Voice OS asked: For checkout?").
	context?: string;
}

export type Judge = <K extends JudgeKey>(params: JudgeParams<K>) => Promise<JudgeAnswer<K>>;

const JUDGE_SYSTEM =
	'You read what a developer said to Voice OS, a voice assistant for coding sessions, in any language, and answer one question about what the words mean. Judge the meaning, not the language or wording. When the words do not clearly answer the question, answer unclear.';

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
					max_tokens: 30,
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
