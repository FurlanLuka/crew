// A forked, unsaved copy of a session's conversation, asked one thing while the session keeps
// working: the aside's side answer and another session's ask both run through here.
import { query as sdkQuery, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { readSpokenTag } from '../shared/spoken-tags.js';
import type { RawMessage } from './events.js';
import { buildQueryOptions, type QueryLaunch } from './worker.js';

export const readText = (message: RawMessage): string => {
	const content = message.message?.content;

	if (!Array.isArray(content)) {
		return '';
	}

	return (content as Record<string, unknown>[])
		.filter((block) => block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text as string)
		.join('\n');
};

export const hasToolUse = (message: RawMessage): boolean => {
	const content = message.message?.content;

	return (
		Array.isArray(content) &&
		(content as Record<string, unknown>[]).some((block) => block.type === 'tool_use')
	);
};

export const isTopLevelAssistant = (message: RawMessage): boolean =>
	message.type === 'assistant' && !message.parent_tool_use_id;

// The fork resumes mid-work and may first finish a message it had started — a checkpoint, with its
// own spoken line. Those are left out; an answer split over several messages stays whole.
export const dropCheckpoints = (texts: string[]): { kept: string[]; dropped: number } => {
	const kept = texts.filter((text, index) => index === texts.length - 1 || !readSpokenTag(text));

	return { kept, dropped: texts.length - kept.length };
};

export interface RunForkParams {
	launch: QueryLaunch;
	sessionId: string;
	prompt: string;
	maxTurns: number;
	preToolUse: HookCallback;
	timeoutMs: number;
	// Seen as each message arrives: true stops the fork there (what came so far is kept).
	shouldStop?: (message: RawMessage) => boolean;
	runQuery?: typeof sdkQuery;
}

export type ForkRun =
	| { kind: 'done'; messages: RawMessage[] }
	| { kind: 'stopped'; messages: RawMessage[] }
	| { kind: 'timed_out' }
	| { kind: 'failed'; reason: string };

export const runFork = async ({
	launch,
	sessionId,
	prompt,
	maxTurns,
	preToolUse,
	timeoutMs,
	shouldStop,
	runQuery = sdkQuery,
}: RunForkParams): Promise<ForkRun> => {
	const abort = new AbortController();
	const messages: RawMessage[] = [];
	// An object, so the timer's write is visible where it is read after the loop.
	const stop: { reason: 'timeout' | 'stopped' | null } = { reason: null };
	const timer = setTimeout(() => {
		stop.reason = 'timeout';
		abort.abort();
	}, timeoutMs);

	try {
		// Forked from the end, even mid tool call: the CLI resumes an unanswered call fine, while a
		// resumeSessionAt uuid can name a message the transcript does not hold yet.
		const forked = runQuery({
			prompt,
			options: {
				...buildQueryOptions(launch),
				abortController: abort,
				resume: sessionId,
				forkSession: true,
				persistSession: false,
				maxTurns,
				// Deny rules and allow rules both run after hooks: the hook decides every tool call.
				hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
			},
		});

		for await (const message of forked) {
			const raw = message as unknown as RawMessage;

			messages.push(raw);

			if (shouldStop?.(raw)) {
				stop.reason = 'stopped';
				abort.abort();
				break;
			}
		}
	} catch (error) {
		if (!abort.signal.aborted) {
			return { kind: 'failed', reason: String(error) };
		}
	} finally {
		clearTimeout(timer);
	}

	if (stop.reason === 'timeout') {
		return { kind: 'timed_out' };
	}

	return stop.reason === 'stopped' ? { kind: 'stopped', messages } : { kind: 'done', messages };
};
