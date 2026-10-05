import { query as sdkQuery, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../log.js';
import type { RawMessage } from './events.js';
import { dropCheckpoints, hasToolUse, isTopLevelAssistant, readText, runFork } from './fork.js';
import type { QueryLaunch } from './worker.js';

const log = createLogger('side-answer');

export const SIDE_ANSWER_TIMEOUT_MS = 60_000;

const NEEDS_TOOLS = 'NEEDS_TOOLS';
const CHANGES_WORK = 'CHANGES_WORK';

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

export const classifySideAnswer = (messages: RawMessage[]): SideAnswerOutcome => {
	// Whatever the fork could not answer beside the work becomes work: queued, never dropped.
	const assistantMessages = messages.filter(isTopLevelAssistant);

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

	const { kept, dropped } = dropCheckpoints(texts);

	return { status: 'answered', answer: kept.join('\n').trim(), dropped };
};

const denyEveryTool: HookCallback = async () => ({
	hookSpecificOutput: {
		hookEventName: 'PreToolUse' as const,
		permissionDecision: 'deny' as const,
		permissionDecisionReason: 'A side answer runs no tools.',
	},
});

export interface RunSideAnswerParams {
	launch: QueryLaunch;
	sessionId: string | null;
	question: string;
	runQuery?: typeof sdkQuery;
	timeoutMs?: number;
}

export const isChangingWork = (outcome: SideAnswerOutcome): boolean =>
	// The fork found the question means the current work should change: a switch, not a queue.
	outcome.status === 'queued' && outcome.reason === CHANGES_WORK;

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

	log.info('start', { cwd: launch.cwd, sessionId, chars: question.length });

	const run = await runFork({
		launch,
		sessionId,
		prompt: buildSidePrompt(question),
		maxTurns: 1,
		preToolUse: denyEveryTool,
		timeoutMs,
		// Reaching for a tool already means "not answerable aside": no need to wait for the denial.
		shouldStop: (message) => isTopLevelAssistant(message) && hasToolUse(message),
		runQuery,
	});

	if (run.kind === 'failed') {
		log.warn('failed', { sessionId, error: run.reason, ms: Date.now() - startedAt });

		return { status: 'failed', reason: run.reason };
	}

	if (run.kind === 'timed_out') {
		log.warn('timed out', { sessionId, ms: Date.now() - startedAt });

		return { status: 'failed', reason: 'timed out' };
	}

	const messages = run.messages;
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
