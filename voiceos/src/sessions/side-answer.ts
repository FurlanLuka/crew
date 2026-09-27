import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../log.js';
import { readSpokenTag } from '../shared/spoken-tags.js';
import type { RawMessage } from './events.js';
import { buildQueryOptions, type QueryLaunch } from './worker.js';

const log = createLogger('side-answer');

export const SIDE_ANSWER_TIMEOUT_MS = 60_000;

const NEEDS_TOOLS = 'NEEDS_TOOLS';
export const CHANGES_WORK = 'CHANGES_WORK';

export const buildSidePrompt = (question: string): string =>
	[
		'Side question from the developer while you work on something else. It is not a new task.',
		`Answer only from this conversation, without tools, in one or two short spoken sentences. Your reply is that answer and nothing else: no progress or checkpoint about your current work — that is said on its own. If you would need tools or files to answer, reply exactly ${NEEDS_TOOLS}. If the question means your current work should change, reply exactly ${CHANGES_WORK}.`,
		'',
		question,
	].join('\n');

export type SideAnswerOutcome =
	// dropped: earlier messages left out (a checkpoint the fork finished before answering).
	| { status: 'answered'; answer: string; dropped: number }
	| { status: 'queued'; reason: string }
	| { status: 'failed'; reason: string };

const readText = (message: RawMessage): string => {
	const content = message.message?.content;

	if (!Array.isArray(content)) {
		return '';
	}

	return (content as Record<string, unknown>[])
		.filter((block) => block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text as string)
		.join('\n');
};

const hasToolUse = (message: RawMessage): boolean => {
	const content = message.message?.content;

	return (
		Array.isArray(content) &&
		(content as Record<string, unknown>[]).some((block) => block.type === 'tool_use')
	);
};

export const classifySideAnswer = (messages: RawMessage[]): SideAnswerOutcome => {
	// Whatever the fork could not answer beside the work becomes work: queued, never dropped.
	const assistantMessages = messages.filter(
		(message) => message.type === 'assistant' && !message.parent_tool_use_id,
	);

	if (assistantMessages.some(hasToolUse)) {
		return { status: 'queued', reason: 'reached for a tool' };
	}

	const result = messages.find((message) => message.type === 'result');

	if (result?.is_error && result.subtype !== 'error_max_turns') {
		return { status: 'failed', reason: result.subtype ?? 'error result' };
	}

	const texts = assistantMessages.map(readText).filter((text) => text.trim());
	const reply = texts.join('\n').trim();

	if (!reply || result?.subtype === 'error_max_turns') {
		return { status: 'queued', reason: reply ? 'ran out of turns' : 'no answer' };
	}

	// Anywhere in the reply: the model often explains first ("I'd have to open it — NEEDS_TOOLS").
	const marker = [NEEDS_TOOLS, CHANGES_WORK].find((word) => reply.includes(word));

	if (marker) {
		return { status: 'queued', reason: marker };
	}

	// The fork resumes mid-work and may first finish a message it had started — a checkpoint, with
	// its own spoken line. Those are left out; an answer split over several messages stays whole.
	const kept = texts.filter((text, index) => index === texts.length - 1 || !readSpokenTag(text));

	return {
		status: 'answered',
		answer: kept.join('\n').trim(),
		dropped: texts.length - kept.length,
	};
};

export interface RunSideAnswerParams {
	launch: QueryLaunch;
	sessionId: string | null;
	question: string;
	runQuery?: typeof sdkQuery;
	timeoutMs?: number;
}

export const runSideAnswer = async ({
	launch,
	sessionId,
	question,
	runQuery = sdkQuery,
	timeoutMs = SIDE_ANSWER_TIMEOUT_MS,
}: RunSideAnswerParams): Promise<SideAnswerOutcome> => {
	if (!sessionId) {
		return { status: 'queued', reason: 'no conversation to fork yet' };
	}

	const startedAt = Date.now();
	const abort = new AbortController();
	const messages: RawMessage[] = [];
	// An object, so the timer's write is visible where it is read after the loop.
	const stop: { reason: 'timeout' | 'tool use' | null } = { reason: null };
	const timer = setTimeout(() => {
		stop.reason = 'timeout';
		abort.abort();
	}, timeoutMs);

	log.info('start', { cwd: launch.cwd, sessionId, chars: question.length });

	try {
		// Forked from the end, even mid tool call: the CLI resumes an unanswered call fine, while a
		// resumeSessionAt uuid can name a message the transcript does not hold yet.
		const sideQuery = runQuery({
			prompt: buildSidePrompt(question),
			options: {
				...buildQueryOptions(launch),
				abortController: abort,
				resume: sessionId,
				forkSession: true,
				persistSession: false,
				maxTurns: 1,
				// Deny rules and allow rules both run after hooks: this stops even an always-allowed tool.
				hooks: {
					PreToolUse: [
						{
							hooks: [
								async () => ({
									hookSpecificOutput: {
										hookEventName: 'PreToolUse' as const,
										permissionDecision: 'deny' as const,
										permissionDecisionReason: 'A side answer runs no tools.',
									},
								}),
							],
						},
					],
				},
			},
		});

		for await (const message of sideQuery) {
			const raw = message as unknown as RawMessage;

			messages.push(raw);

			// Reaching for a tool already means "not answerable aside": no need to wait for the denial.
			if (raw.type === 'assistant' && !raw.parent_tool_use_id && hasToolUse(raw)) {
				stop.reason = 'tool use';
				abort.abort();
				break;
			}
		}
	} catch (error) {
		if (!abort.signal.aborted) {
			log.warn('failed', { sessionId, error: String(error), ms: Date.now() - startedAt });

			return { status: 'failed', reason: String(error) };
		}
	} finally {
		clearTimeout(timer);
	}

	if (stop.reason === 'timeout') {
		log.warn('timed out', { sessionId, ms: Date.now() - startedAt });

		return { status: 'failed', reason: 'timed out' };
	}

	const outcome = classifySideAnswer(messages);

	log.info('settled', {
		sessionId,
		status: outcome.status,
		...(outcome.status === 'answered'
			? { chars: outcome.answer.length, dropped: outcome.dropped }
			: { reason: outcome.reason }),
		ms: Date.now() - startedAt,
	});

	return outcome;
};
