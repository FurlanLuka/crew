import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { createLogger } from '../log.js';

// A session that writes its own spoken line skips the narrator, which was the only thing naming its
// topic: this small call keeps the topic (Mission Control, the kernel's answers) on the current work.

const log = createLogger('topic');

// Naming the work is a small, cheap call: Haiku.
export const TOPIC_MODEL = 'claude-haiku-4-5';
const MAX_BODY_CHARS = 2_000;

export interface TopicInput {
	ref: string;
	label: string;
	asked: string | null;
	spoken: string;
	body: string;
	topic: string | null;
}

export interface TopicResult {
	topic: string | null;
	// When the session asks the developer something: what the decision is about, in a few words.
	about: string | null;
}

export type WriteTopic = (input: TopicInput) => Promise<TopicResult>;

const topicSchema = z.object({ topic: z.string().nullable(), about: z.string().nullable() });

export const TOPIC_SYSTEM = `You name what a coding session is working on, for a developer who runs several at once. You get what the developer last asked it, the line it said back, the rest of its message, and its current topic.

Return topic: at most 8 words, like "Checkout retry backoff" or "Voice notes per workspace" — the work itself, in the session's terms, never a status ("Waiting on review") or a verdict. Keep the current topic, word for word, while the session is still on that work; change it when the work moved on. null only when nothing says what the work is.

Return about: only when the line asks the developer something (a question, a choice, an approval) — at most 5 words naming what the decision is about, like "where notes should live" or "pushing to main". Otherwise null.`;

export const buildTopicMessage = ({ label, asked, spoken, body, topic }: TopicInput): string =>
	[
		`session: ${label}`,
		`current topic: ${topic ?? 'none'}`,
		`the developer asked: ${asked ?? '(nothing recorded)'}`,
		`it said: ${spoken}`,
		`the rest of its message: ${body.slice(0, MAX_BODY_CHARS) || '(none)'}`,
	].join('\n');

export const createTopicWriter = (apiKey: string | null, model = TOPIC_MODEL): WriteTopic => {
	const client = apiKey ? new Anthropic({ apiKey, maxRetries: 1, timeout: 15_000 }) : null;

	return async (input) => {
		const unchanged: TopicResult = { topic: input.topic, about: null };

		if (!client) {
			return unchanged;
		}

		const startedAt = Date.now();

		try {
			const response = await client.messages.parse({
				model,
				max_tokens: 80,
				system: [{ type: 'text', text: TOPIC_SYSTEM, cache_control: { type: 'ephemeral' } }],
				messages: [{ role: 'user', content: buildTopicMessage(input) }],
				output_config: { format: zodOutputFormat(topicSchema) },
			});
			const topic = response.parsed_output?.topic?.trim() || null;
			const about = response.parsed_output?.about?.trim() || null;

			log.info('topic written', {
				ref: input.ref,
				ms: Date.now() - startedAt,
				isChanged: topic !== null && topic !== input.topic,
				hasAbout: about !== null,
			});

			return { topic: topic ?? input.topic, about };
		} catch (error) {
			log.warn('topic not written', { ref: input.ref, error: String(error) });

			return unchanged;
		}
	};
};
