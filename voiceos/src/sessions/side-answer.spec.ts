import { describe, expect, it } from 'bun:test';
import type { RawMessage } from './events.js';
import {
	buildSidePrompt,
	classifySideAnswer,
	isChangingWork,
	runSideAnswer,
	type RunSideAnswerParams,
} from './side-answer.js';
import { buildQueryOptions, type QueryLaunch } from './worker.js';

const text = (value: string): RawMessage => ({
	type: 'assistant',
	message: { content: [{ type: 'text', text: value }] },
});
const toolUse: RawMessage = {
	type: 'assistant',
	message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
};
const success: RawMessage = { type: 'result', subtype: 'success', result: '' };

describe('classifySideAnswer', () => {
	it('text → answered with the last message: the fork may first finish one it had started', () =>
		expect(
			classifySideAnswer([
				text('<spoken>The pause-and-join is built; reviewers are checking it.</spoken>'),
				text(
					'<spoken>About half: 259 calls instead of 519.</spoken>\nThe must-hold cases still run three times.',
				),
				success,
			]),
		).toEqual({
			status: 'answered',
			answer:
				'<spoken>About half: 259 calls instead of 519.</spoken>\nThe must-hold cases still run three times.',
			dropped: 1,
		}));

	it('an answer split over several messages without a spoken line → kept whole', () =>
		expect(classifySideAnswer([text('The router.'), text('In src/router.'), success])).toEqual({
			status: 'answered',
			answer: 'The router.\nIn src/router.',
			dropped: 0,
		}));

	it('an empty last message is not the answer; blocks of one message are joined', () => {
		expect(
			classifySideAnswer([
				text('<spoken>Checkpoint.</spoken>'),
				text('The answer.'),
				text('  '),
				success,
			]),
		).toMatchObject({ status: 'answered', answer: 'The answer.' });
		expect(
			classifySideAnswer([
				{
					type: 'assistant',
					message: {
						content: [
							{ type: 'text', text: 'The router.' },
							{ type: 'text', text: 'In src/router.' },
						],
					},
				},
				success,
			]),
		).toMatchObject({ answer: 'The router.\nIn src/router.' });
	});

	it('a marker in an earlier message still sends it to the queue', () =>
		expect(classifySideAnswer([text('NEEDS_TOOLS'), text('Anyway.'), success]).status).toBe(
			'queued',
		));

	it('text then a tool call → queued, and the text is not the answer', () =>
		expect(classifySideAnswer([text('Let me check.'), toolUse]).status).toBe('queued'));

	it.each(['NEEDS_TOOLS', 'NEEDS_TOOLS.', ' NEEDS_TOOLS\n', 'CHANGES_WORK'])(
		'%p → queued',
		(reply) => expect(classifySideAnswer([text(reply), success]).status).toBe('queued'),
	);

	it.each([
		'NEEDS_TOOLS\nI would need to read the file',
		'CHANGES_WORK: it should use v2',
		"I'd have to open it — NEEDS_TOOLS",
	])('%p → queued: the marker is never spoken', (reply) =>
		expect(classifySideAnswer([text(reply), success]).status).toBe('queued'),
	);

	it('no text → queued', () => expect(classifySideAnswer([success]).status).toBe('queued'));

	it('out of turns → queued, not failed', () =>
		expect(
			classifySideAnswer([
				text('Partial'),
				{ type: 'result', subtype: 'error_max_turns', is_error: true },
			]).status,
		).toBe('queued'));

	it('an error result → failed', () =>
		expect(
			classifySideAnswer([{ type: 'result', subtype: 'error_during_execution', is_error: true }])
				.status,
		).toBe('failed'));

	it("a sub-agent's text → not the answer", () =>
		expect(
			classifySideAnswer([{ ...text('inner'), parent_tool_use_id: 'x' }, success]).status,
		).toBe('queued'));
});

const launch: QueryLaunch = {
	cwd: '/w/store',
	dirs: ['/w/shared'],
	env: { HOME: '/h' },
	orientation: 'You are in store/main.',
	model: 'claude-sonnet-5',
	claudeBin: '/bin/claude',
};

interface FakeCall {
	prompt: string;
	options: Record<string, unknown> & { abortController: AbortController };
}

const fakeQuery = (messages: RawMessage[] | 'hang' | Error) => {
	const calls: FakeCall[] = [];
	const runQuery = ((call: FakeCall) => {
		calls.push(call);

		return {
			async *[Symbol.asyncIterator]() {
				if (messages instanceof Error) {
					throw messages;
				}

				if (messages === 'hang') {
					await new Promise((_, reject) =>
						call.options.abortController.signal.addEventListener('abort', () =>
							reject(new Error('aborted')),
						),
					);
				}

				for (const message of messages as RawMessage[]) {
					yield message;
				}
			},
		};
	}) as unknown as RunSideAnswerParams['runQuery'];

	return { calls, runQuery };
};

const ask = (
	runQuery: RunSideAnswerParams['runQuery'],
	overrides: Partial<RunSideAnswerParams> = {},
) =>
	runSideAnswer({
		launch,
		sessionId: 'sess1',
		question: 'which file did you change?',
		runQuery,
		...overrides,
	});

describe('runSideAnswer', () => {
	it('forks the session from its end, with the same launch as the session and no tools', async () => {
		const fake = fakeQuery([text('The router.'), success]);

		expect(await ask(fake.runQuery)).toEqual({
			status: 'answered',
			answer: 'The router.',
			dropped: 0,
		});

		const [call] = fake.calls;

		expect(call?.prompt).toContain('which file did you change?');
		expect(call?.options).toMatchObject({
			...buildQueryOptions(launch),
			resume: 'sess1',
			forkSession: true,
			persistSession: false,
			maxTurns: 1,
		});
		expect(call?.options).not.toHaveProperty('resumeSessionAt');

		const hooks = call?.options.hooks as
			| { PreToolUse: { hooks: (() => Promise<unknown>)[] }[] }
			| undefined;
		const denyHook = hooks?.PreToolUse[0]?.hooks[0];

		expect(await denyHook?.()).toMatchObject({
			hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
		});
	});

	it('no session id → queued without starting anything', async () => {
		const fake = fakeQuery([]);

		expect((await ask(fake.runQuery, { sessionId: null })).status).toBe('queued');
		expect(fake.calls).toEqual([]);
	});

	it('it reaches for a tool → aborted at once, queued', async () => {
		const fake = fakeQuery([toolUse, text('never read')]);

		expect((await ask(fake.runQuery)).status).toBe('queued');
		expect(fake.calls[0]?.options.abortController.signal.aborted).toBe(true);
	});

	it('the query throws → failed', async () => {
		expect((await ask(fakeQuery(new Error('resume refused')).runQuery)).status).toBe('failed');
	});

	it('no answer within the time → aborted, failed', async () => {
		const fake = fakeQuery('hang');

		expect(await ask(fake.runQuery, { timeoutMs: 10 })).toEqual({
			status: 'failed',
			reason: 'timed out',
		});
		expect(fake.calls[0]?.options.abortController.signal.aborted).toBe(true);
	});
});

describe('buildSidePrompt', () => {
	it('asks for the answer alone: no progress about the work it was forked from', () =>
		expect(buildSidePrompt('how much cheaper is it?')).toContain(
			'no progress or checkpoint about your current work',
		));
});

describe('isChangingWork', () => {
	it.each([
		['CHANGES_WORK', true],
		['CHANGES_WORK: it should use v2', true],
		['NEEDS_TOOLS', false],
		['NEEDS_TOOLS, and CHANGES_WORK too', false],
		['The router.', false],
	])('%p → %p', (reply, expected) =>
		expect(isChangingWork(classifySideAnswer([text(reply), success]))).toBe(expected),
	);
});
