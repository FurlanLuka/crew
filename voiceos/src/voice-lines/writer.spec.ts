import { describe, expect, it } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { configureLog } from '../log.js';
import type { FollowUpInput } from './prompt.js';
import { createFallbackWriter, createVoiceLineWriter } from './writer.js';

configureLog({ quiet: true });

type Create = (params: unknown, options: { signal: AbortSignal }) => Promise<unknown>;

const clientWith = (create: Create) => ({ messages: { create } }) as unknown as Anthropic;

const answering =
	(text: string): Create =>
	async () => ({ content: [{ type: 'text', text }] });

const failing: Create = async () => {
	throw new Error('overloaded');
};

// Answers only once aborted: the writer's own timeout is what ends the call.
const hanging: Create = (_params, { signal }) =>
	new Promise((_resolve, reject) => {
		signal.addEventListener('abort', () => reject(new Error('aborted')));
	});

const FOLLOW_UP: FollowUpInput = {
	facts: { kind: 'sent', label: 'checkout, main', offersSwitch: true },
	fixedText: 'Sent to checkout, main. Switch there?',
	lastAck: 'Okay.',
};

describe('the follow-up writer', () => {
	it('a line that keeps every rule → said', async () => {
		const writer = createVoiceLineWriter({
			apiKey: 'k',
			client: clientWith(answering('"Checkout, main has it. Go there?"')),
		});

		expect(await writer.followUp(FOLLOW_UP)).toBe('Checkout, main has it. Go there?');
	});

	it.each([
		['the label changed', 'Checkout has it. Go there?'],
		['the offered question dropped', 'Checkout, main has it.'],
		['the wake word', 'Voice OS gave checkout, main the words. Go there?'],
		['over 25 words', `Checkout, main has it ${'and more words here '.repeat(6)}. Go there?`],
	])('%s → null: the fixed line is said', async (_, line) => {
		const writer = createVoiceLineWriter({ apiKey: 'k', client: clientWith(answering(line)) });

		expect(await writer.followUp(FOLLOW_UP)).toBeNull();
	});

	it('the call fails or is too slow → null', async () => {
		const broken = createVoiceLineWriter({ apiKey: 'k', client: clientWith(failing) });
		const slow = createVoiceLineWriter({
			apiKey: 'k',
			client: clientWith(hanging),
			followUpTimeoutMs: 20,
		});

		expect(await broken.followUp(FOLLOW_UP)).toBeNull();
		expect(await slow.followUp(FOLLOW_UP)).toBeNull();
	});

	it('one try only, with the facts and the ack in the message, Haiku, no retries', async () => {
		const calls: { model?: string; messages?: { content: string }[] }[] = [];
		const writer = createVoiceLineWriter({
			apiKey: 'k',
			client: clientWith(async (params) => {
				calls.push(params as (typeof calls)[number]);
				throw new Error('overloaded');
			}),
		});

		await writer.followUp(FOLLOW_UP);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.model).toBe('claude-haiku-4-5');
		expect(calls[0]?.messages?.[0]?.content).toContain('just said: Okay.');
	});
});

describe('no Anthropic key', () => {
	it('the fallback writer: fixed follow-ups', async () => {
		const writer = createVoiceLineWriter({ apiKey: null });

		expect(await writer.followUp(FOLLOW_UP)).toBeNull();
		expect(await createFallbackWriter().followUp(FOLLOW_UP)).toBeNull();
	});
});
