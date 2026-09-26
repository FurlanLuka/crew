import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createLogger } from '../log.js';
import {
	cleanSpokenText,
	createFallbackNarration,
	NARRATOR_MODEL,
	NARRATOR_SYSTEM,
	narrationSchema,
	buildNarratorMessage,
	type Narration,
	type NarratorInput,
} from './prompt.js';

const log = createLogger('narrator');

export type NarrateFunction = (input: NarratorInput) => Promise<Narration>;

export const createNarrator = (apiKey: string | null, model = NARRATOR_MODEL): NarrateFunction => {
	const client = apiKey ? new Anthropic({ apiKey, maxRetries: 2, timeout: 20_000 }) : null;

	return async (input) => {
		if (!client) {
			return createFallbackNarration(input);
		}

		const startedAt = Date.now();

		try {
			const response = await client.messages.parse({
				model,
				max_tokens: 400,
				system: [{ type: 'text', text: NARRATOR_SYSTEM, cache_control: { type: 'ephemeral' } }],
				messages: [{ role: 'user', content: buildNarratorMessage(input) }],
				output_config: { format: zodOutputFormat(narrationSchema) },
			});
			const parsed = response.parsed_output;

			if (!parsed) {
				throw new Error(`no parsed output (stop_reason ${response.stop_reason})`);
			}

			log.info('narrated', {
				ref: input.label,
				ms: Date.now() - startedAt,
				speak: parsed.speak,
				needsUser: parsed.needs_user,
			});

			return { ...parsed, text: cleanSpokenText(parsed.text) };
		} catch (error) {
			log.warn('narrator failed, using fallback', { ref: input.label, error: String(error) });

			return createFallbackNarration(input);
		}
	};
};
