import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { createLogger } from '../log.js';

// A session that asks in its own spoken line skips the narrator: this small call names what the
// question is about, for the "checkout needs you: <about>" heard from another screen.

const log = createLogger('about');

// A few words from a short message: Haiku.
export const ABOUT_MODEL = 'claude-haiku-4-5';
const MAX_BODY_CHARS = 2_000;

export interface AboutInput {
	ref: string;
	label: string;
	asked: string | null;
	spoken: string;
	body: string;
}

export type WriteAbout = (input: AboutInput) => Promise<string | null>;

const aboutSchema = z.object({ about: z.string().nullable() });

export const ABOUT_SYSTEM = `A coding session asked the developer something. You get what the developer last asked it, the line it asked with, and the rest of its message.

Return about: at most 5 words naming what the decision is about, like "where notes should live" or "pushing to main". null when nothing says.`;

export const buildAboutMessage = ({ label, asked, spoken, body }: AboutInput): string =>
	[
		`session: ${label}`,
		`the developer asked: ${asked ?? '(nothing recorded)'}`,
		`it said: ${spoken}`,
		`the rest of its message: ${body.slice(0, MAX_BODY_CHARS) || '(none)'}`,
	].join('\n');

export const createAboutWriter = (apiKey: string | null, model = ABOUT_MODEL): WriteAbout => {
	const client = apiKey ? new Anthropic({ apiKey, maxRetries: 1, timeout: 15_000 }) : null;

	return async (input) => {
		if (!client) {
			return null;
		}

		const startedAt = Date.now();

		try {
			const response = await client.messages.parse({
				model,
				max_tokens: 60,
				system: [{ type: 'text', text: ABOUT_SYSTEM, cache_control: { type: 'ephemeral' } }],
				messages: [{ role: 'user', content: buildAboutMessage(input) }],
				output_config: { format: zodOutputFormat(aboutSchema) },
			});
			const about = response.parsed_output?.about?.trim() || null;

			log.info('about written', {
				ref: input.ref,
				ms: Date.now() - startedAt,
				hasAbout: about !== null,
			});

			return about;
		} catch (error) {
			log.warn('about not written', { ref: input.ref, error: String(error) });

			return null;
		}
	};
};
