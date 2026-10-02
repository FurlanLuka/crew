// Words Voice OS's follow-up and progress lines with Haiku, on its own small call. Never in the way:
// one try, a short timeout, and on any failure the fixed line (a follow-up) or a plain one (progress).
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../log.js';
import {
	buildFollowUpMessage,
	buildProgressMessage,
	cleanWordedLine,
	composeProgressFallback,
	findFollowUpProblem,
	findProgressProblem,
	FOLLOW_UP_SYSTEM,
	type FollowUpInput,
	PROGRESS_SYSTEM,
	type ProgressInput,
	VOICE_LINES_MODEL,
} from './prompt.js';

const log = createLogger('voice-lines');

// voice-out holds the line's place for at most a second: a later answer is thrown away anyway.
const FOLLOW_UP_TIMEOUT_MS = 1_500;
// Nobody waits on a progress line, but one about a step long gone says nothing.
const PROGRESS_TIMEOUT_MS = 5_000;
const MAX_TOKENS = 80;

export interface VoiceLineWriter {
	// The worded line, or null to say the fixed one.
	followUp: (input: FollowUpInput) => Promise<string | null>;
	progress: (input: ProgressInput) => Promise<string>;
}

export interface Worded {
	text: string;
	// Why it is not said; null when it keeps every rule.
	problem: string | null;
}

interface AskParams {
	client: Anthropic;
	system: string;
	message: string;
	timeoutMs: number;
	model?: string;
}

const ask = async ({
	client,
	system,
	message,
	timeoutMs,
	model = VOICE_LINES_MODEL,
}: AskParams): Promise<string> => {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), timeoutMs);

	try {
		const response = await client.messages.create(
			{
				model,
				max_tokens: MAX_TOKENS,
				system,
				messages: [{ role: 'user', content: message }],
			},
			{ signal: abort.signal },
		);
		const block = response.content.find((part) => part.type === 'text');

		return cleanWordedLine(block?.type === 'text' ? block.text : '');
	} finally {
		clearTimeout(timer);
	}
};

interface WordParams {
	client: Anthropic;
	timeoutMs?: number;
	model?: string;
}

// One call and its verdict, shared by the writer and the eval: throws on a failed or timed-out call.
export const wordFollowUp = async (
	input: FollowUpInput,
	{ client, timeoutMs = FOLLOW_UP_TIMEOUT_MS, model }: WordParams,
): Promise<Worded> => {
	const text = await ask({
		client,
		system: FOLLOW_UP_SYSTEM,
		message: buildFollowUpMessage(input),
		timeoutMs,
		...(model ? { model } : {}),
	});

	return { text, problem: findFollowUpProblem(text, input.facts) };
};

export const wordProgress = async (
	input: ProgressInput,
	{ client, timeoutMs = PROGRESS_TIMEOUT_MS, model }: WordParams,
): Promise<Worded> => {
	const text = await ask({
		client,
		system: PROGRESS_SYSTEM,
		message: buildProgressMessage(input),
		timeoutMs,
		...(model ? { model } : {}),
	});

	return { text, problem: findProgressProblem(text) };
};

// No key: every line is the fixed or plain one, at once.
export const createFallbackWriter = (): VoiceLineWriter => ({
	followUp: () => Promise.resolve(null),
	progress: (input) => Promise.resolve(composeProgressFallback(input)),
});

interface CreateVoiceLineWriterParams {
	apiKey: string | null;
	client?: Anthropic;
	followUpTimeoutMs?: number;
	progressTimeoutMs?: number;
	now?: () => number;
}

export const createVoiceLineWriter = ({
	apiKey,
	client,
	followUpTimeoutMs = FOLLOW_UP_TIMEOUT_MS,
	progressTimeoutMs = PROGRESS_TIMEOUT_MS,
	now = Date.now,
}: CreateVoiceLineWriterParams): VoiceLineWriter => {
	const anthropic = client ?? (apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : null);

	if (!anthropic) {
		return createFallbackWriter();
	}

	const fallback = createFallbackWriter();

	return {
		followUp: async (input) => {
			const startedAt = now();

			try {
				const worded = await wordFollowUp(input, {
					client: anthropic,
					timeoutMs: followUpTimeoutMs,
				});

				// The kind and the verdict; the line itself is logged when it is queued and said.
				if (worded.problem) {
					log.info('follow-up fallback', {
						kind: input.facts.kind,
						reason: worded.problem,
						ms: now() - startedAt,
					});

					return null;
				}

				log.info('follow-up worded', { kind: input.facts.kind, ms: now() - startedAt });

				return worded.text;
			} catch (error) {
				log.warn('follow-up fallback', {
					kind: input.facts.kind,
					reason: String(error),
					ms: now() - startedAt,
				});

				return null;
			}
		},
		progress: async (input) => {
			const startedAt = now();

			try {
				const worded = await wordProgress(input, {
					client: anthropic,
					timeoutMs: progressTimeoutMs,
				});

				if (worded.problem) {
					log.info('progress fallback', { reason: worded.problem, ms: now() - startedAt });

					return fallback.progress(input);
				}

				log.info('progress worded', { ms: now() - startedAt });

				return worded.text;
			} catch (error) {
				log.warn('progress fallback', { reason: String(error), ms: now() - startedAt });

				return fallback.progress(input);
			}
		},
	};
};
