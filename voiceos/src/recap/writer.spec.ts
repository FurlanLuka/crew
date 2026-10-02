import { describe, expect, it } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { configureLog } from '../log.js';
import type { RecapInput } from './recap.js';
import { createRecapWriter } from './writer.js';

configureLog({ quiet: true });

type Create = (params: unknown, options: { signal: AbortSignal }) => Promise<unknown>;

const clientWith = (create: Create) => ({ messages: { create } }) as unknown as Anthropic;

const RECAP: RecapInput = { window: 'the last hour', isOneSession: false, sessions: [] };

describe('createRecapWriter', () => {
	it('a worded recap → said as written; the call carries the recap and Haiku', async () => {
		const calls: { model?: string; messages?: { content: string }[] }[] = [];
		const write = createRecapWriter({
			apiKey: 'k',
			client: clientWith(async (params) => {
				calls.push(params as never);

				return { content: [{ type: 'text', text: '  Checkout is waiting on you.  ' }] };
			}),
		});

		expect(await write(RECAP)).toBe('Checkout is waiting on you.');
		expect(calls[0]?.model).toBe('claude-haiku-4-5');
		expect(calls[0]?.messages?.[0]?.content).toContain('time asked about: the last hour');
	});

	it('no key, a failure, an empty answer or a timeout → null, so the plain recap is said', async () => {
		const hanging: Create = (_params, { signal }) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')));
			});

		expect(await createRecapWriter({ apiKey: null })(RECAP)).toBeNull();
		expect(
			await createRecapWriter({
				apiKey: 'k',
				client: clientWith(async () => {
					throw new Error('overloaded');
				}),
			})(RECAP),
		).toBeNull();
		expect(
			await createRecapWriter({
				apiKey: 'k',
				client: clientWith(async () => ({ content: [{ type: 'text', text: ' ' }] })),
			})(RECAP),
		).toBeNull();
		expect(
			await createRecapWriter({ apiKey: 'k', client: clientWith(hanging), timeoutMs: 20 })(RECAP),
		).toBeNull();
	});
});
