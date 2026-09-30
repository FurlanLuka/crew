import { describe, expect, it } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { configureLog } from '../log.js';
import { createJudge } from './judge.js';

configureLog({ quiet: true });

type Create = (params: unknown, options: { signal: AbortSignal }) => Promise<unknown>;

const clientWith = (create: Create) => ({ messages: { create } }) as unknown as Anthropic;

const answering =
	(verdict: unknown): Create =>
	async () => ({
		content: [{ type: 'tool_use', id: 't1', name: 'verdict', input: { verdict } }],
	});

describe('createJudge', () => {
	it('the verdict the model gives, when it is one the question allows', async () => {
		const judge = createJudge({ apiKey: 'k', client: clientWith(answering('yes')) });

		expect(await judge({ key: 'approves', utterance: 'Ja, mach das.' })).toBe('yes');
	});

	it('a verdict the question does not allow → unclear', async () => {
		const judge = createJudge({ apiKey: 'k', client: clientWith(answering('maybe')) });

		expect(await judge({ key: 'approves', utterance: 'Ja.' })).toBe('unclear');
	});

	it('no answer, a failure, or too slow → unclear: the guard keeps its safe side', async () => {
		const empty = createJudge({ apiKey: 'k', client: clientWith(async () => ({ content: [] })) });
		const failing = createJudge({
			apiKey: 'k',
			client: clientWith(async () => {
				throw new Error('overloaded');
			}),
		});
		const slow = createJudge({
			apiKey: 'k',
			timeoutMs: 20,
			client: clientWith(
				(_params, { signal }) =>
					new Promise((_resolve, reject) => {
						signal.addEventListener('abort', () => reject(new Error('aborted')));
					}),
			),
		});

		expect(await empty({ key: 'take_back', utterance: 'Vergiss es.' })).toBe('unclear');
		expect(await failing({ key: 'take_back', utterance: 'Vergiss es.' })).toBe('unclear');
		expect(await slow({ key: 'take_back', utterance: 'Vergiss es.' })).toBe('unclear');
	});

	it('cut off before the verdict (an empty tool input) → unclear', async () => {
		const truncated = createJudge({
			apiKey: 'k',
			client: clientWith(async () => ({
				stop_reason: 'max_tokens',
				content: [{ type: 'tool_use', id: 't1', name: 'verdict', input: {} }],
			})),
		});

		expect(await truncated({ key: 'approves', utterance: 'Ja.' })).toBe('unclear');
	});

	it("each question's own answers: listen_mode takes off, never yes", async () => {
		const off = createJudge({ apiKey: 'k', client: clientWith(answering('off')) });
		const yes = createJudge({ apiKey: 'k', client: clientWith(answering('yes')) });

		expect(await off({ key: 'listen_mode', utterance: 'Nehaj poslušati.' })).toBe('off');
		expect(await yes({ key: 'listen_mode', utterance: 'Nehaj poslušati.' })).toBe('unclear');
	});

	it('the request: the verdict tool forced, its answers with unclear, the context line when given', async () => {
		const sent: unknown[] = [];
		const judge = createJudge({
			apiKey: 'k',
			client: clientWith(async (params) => {
				sent.push(params);

				return { content: [] };
			}),
		});

		await judge({
			key: 'take_back_before',
			utterance: 'Vergiss das, lint.',
			context: 'The part: "lint."',
		});

		expect(sent[0]).toMatchObject({
			tool_choice: { type: 'tool', name: 'verdict' },
			tools: [
				{
					name: 'verdict',
					input_schema: { properties: { verdict: { enum: ['yes', 'no', 'unclear'] } } },
				},
			],
			messages: [
				{
					role: 'user',
					content: expect.stringContaining(
						'Context: The part: "lint."\nThe developer said: "Vergiss das, lint."',
					),
				},
			],
		});
	});

	it('no key → unclear, and no call', async () => {
		expect(await createJudge({ apiKey: null })({ key: 'mute_only', utterance: 'Tiho.' })).toBe(
			'unclear',
		);
	});
});
