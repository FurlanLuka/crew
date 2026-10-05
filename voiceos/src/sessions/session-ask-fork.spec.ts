import { describe, expect, it } from 'bun:test';
import type { RawMessage } from './events.js';
import {
	buildSessionAskPrompt,
	classifySessionAsk,
	createForkToolHook,
	decideForkTool,
	runSessionAskFork,
} from './session-ask-fork.js';
import type { QueryLaunch } from './worker.js';

const roots = { cwd: '/w/checkout', dirs: [] };
const text = (value: string): RawMessage => ({
	type: 'assistant',
	message: { content: [{ type: 'text', text: value }] },
});
const toolUse = (name: string, input: Record<string, unknown>): RawMessage => ({
	type: 'assistant',
	message: { content: [{ type: 'tool_use', id: 't', name, input }] },
});
const success: RawMessage = { type: 'result', subtype: 'success', result: '' };

describe('decideForkTool', () => {
	it('Read inside its folders → allowed', () =>
		expect(decideForkTool('Read', { file_path: '/w/checkout/src/retry.ts' }, roots)).toEqual({
			kind: 'allow',
		}));

	it('Read of a secret, or outside its folders → denied', () => {
		expect(decideForkTool('Read', { file_path: '/w/checkout/.env.local' }, roots).kind).toBe(
			'deny',
		);
		expect(decideForkTool('Read', { file_path: '/w/store-front/a.ts' }, roots).kind).toBe('deny');
		expect(decideForkTool('Read', {}, roots).kind).toBe('deny');
	});

	it('anything that runs or changes, and every MCP tool → denied with how to ask for work', () => {
		for (const name of ['Bash', 'Edit', 'Write', 'Task', 'WebFetch', 'mcp__voiceos__ask_session']) {
			expect(decideForkTool(name, {}, roots)).toEqual({
				kind: 'deny',
				reason:
					'Only Read, Grep and Glob run here. If answering needs more, reply NEEDS_WORK: and what would have to run.',
			});
		}
	});

	it('Grep over everything → allowed with secret files left out', () =>
		expect(decideForkTool('Grep', { pattern: 'STRIPE' }, roots)).toEqual({
			kind: 'allow',
			updatedInput: {
				pattern: 'STRIPE',
				glob: '!{.env,.env.*,*.pem,*.key,*.p12,id_rsa*,id_ed25519*,*credential*,*secret*}',
			},
		}));

	it('Grep aimed at a secret file, by path or glob → denied; a narrow glob → as asked', () => {
		expect(decideForkTool('Grep', { pattern: 'x', path: '/w/checkout/.env' }, roots).kind).toBe(
			'deny',
		);
		expect(decideForkTool('Grep', { pattern: 'x', glob: '.env*' }, roots).kind).toBe('deny');
		expect(decideForkTool('Grep', { pattern: 'x', glob: '*.ts' }, roots)).toEqual({
			kind: 'allow',
		});
	});

	it('Glob listing secrets → denied; any other pattern → allowed', () => {
		expect(decideForkTool('Glob', { pattern: '**/.env' }, roots).kind).toBe('deny');
		expect(decideForkTool('Glob', { pattern: 'src/**/*.ts' }, roots)).toEqual({ kind: 'allow' });
	});

	it('the hook answers in the SDK shape', async () => {
		const hook = createForkToolHook(roots);
		const signal = new AbortController().signal;

		expect(
			await hook(
				{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} } as never,
				't',
				{ signal },
			),
		).toMatchObject({
			hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
		});
	});
});

describe('classifySessionAsk', () => {
	it('read a file, then answered → the answer and what it read', () =>
		expect(
			classifySessionAsk([
				toolUse('Read', { file_path: '/w/checkout/src/retry.ts' }),
				text('Five tries, from 200 ms to 3.2 s.'),
				success,
			]),
		).toEqual({
			status: 'answered',
			answer: 'Five tries, from 200 ms to 3.2 s.',
			files: [],
			read: ['/w/checkout/src/retry.ts'],
		}));

	it('a FILES list → the answer without it, the paths handed over once each', () =>
		expect(
			classifySessionAsk([
				text('The schema is in db.\nFILES:\n- db/schema.sql\n- db/schema.sql\ndb/seed.sql'),
				success,
			]),
		).toMatchObject({ answer: 'The schema is in db.', files: ['db/schema.sql', 'db/seed.sql'] }));

	it('NEEDS_WORK anywhere → what would have to run', () =>
		expect(
			classifySessionAsk([
				text(
					'I cannot check that from here. NEEDS_WORK: run bun test payments against staging\nthanks',
				),
				success,
			]),
		).toEqual({
			status: 'needs_work',
			answer: 'run bun test payments against staging',
			files: [],
			read: [],
		}));

	it('a checkpoint the copy finished first → left out', () =>
		expect(
			classifySessionAsk([text('<spoken>Tests run.</spoken>'), text('It is five.'), success])
				.answer,
		).toBe('It is five.'));

	it('no text, an error, or out of turns → failed with why', () => {
		expect(classifySessionAsk([success]).answer).toBe('no answer');
		expect(
			classifySessionAsk([{ type: 'result', subtype: 'error_during_execution', is_error: true }]),
		).toMatchObject({ status: 'failed', answer: 'error_during_execution' });
		expect(
			classifySessionAsk([{ type: 'result', subtype: 'error_max_turns', is_error: true }]).answer,
		).toBe('ran out of turns');
	});
});

describe('the prompt', () => {
	it('says who asks, what the copy may do, the secret rule and the reply shape', () =>
		expect(buildSessionAskPrompt('store-front/main', 'Which retry limit?')).toBe(
			[
				'Another session, store-front/main, asks you this while you work on something else. It is not a new task and not the developer.',
				'Answer from this conversation first. If you need to look something up, read and search files in your own folders (Read, Grep, Glob); nothing else runs here and nothing you do here changes your work.',
				'Never repeat a secret value (a key, token or password): name the variable or the file instead.',
				'Reply with the answer only, written for another Claude: plain and complete, a few sentences or a short list. If answering would need running something (tests, a command, a server, a database), reply NEEDS_WORK: and one line saying exactly what would have to run. To hand over files, end with a line FILES: and then one path per line, inside your folders.',
				'',
				'Which retry limit?',
			].join('\n'),
		));
});

describe('runSessionAskFork', () => {
	const launch: QueryLaunch = { cwd: '/w/checkout', dirs: [], env: {}, orientation: '' };

	it('no conversation yet → failed without forking', async () => {
		let forked = false;
		const runQuery = (() => {
			forked = true;
		}) as never;

		expect(
			await runSessionAskFork({ launch, sessionId: null, fromLabel: 'a', question: 'q', runQuery }),
		).toEqual({ status: 'failed', answer: 'it has no conversation yet', files: [], read: [] });
		expect(forked).toBe(false);
	});

	it('forks the session read-only and answers; never saved, a few turns at most', async () => {
		const calls: { options: Record<string, unknown> }[] = [];
		const runQuery = ((call: { options: Record<string, unknown> }) => {
			calls.push(call);

			return (async function* () {
				yield text('Five.');
				yield success;
			})();
		}) as never;

		expect(
			await runSessionAskFork({ launch, sessionId: 's1', fromLabel: 'a', question: 'q', runQuery }),
		).toMatchObject({ status: 'answered', answer: 'Five.' });
		expect(calls[0]?.options).toMatchObject({
			resume: 's1',
			forkSession: true,
			persistSession: false,
			maxTurns: 8,
			cwd: '/w/checkout',
		});
	});

	it('a copy that never answers → failed when its time is up', async () => {
		const runQuery = (({ options }: { options: { abortController: AbortController } }) =>
			(async function* () {
				await new Promise((resolve) =>
					options.abortController.signal.addEventListener('abort', resolve),
				);
				throw new Error('aborted');
			})()) as never;

		expect(
			await runSessionAskFork({
				launch,
				sessionId: 's1',
				fromLabel: 'a',
				question: 'q',
				runQuery,
				timeoutMs: 20,
			}),
		).toEqual({ status: 'failed', answer: 'it took too long', files: [], read: [] });
	});
});
