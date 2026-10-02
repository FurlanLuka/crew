// Words the status update with Haiku, on its own small call: one try, a short timeout, and null on any
// failure so the plain recap is said instead. Logs how long it took, never the words.
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../log.js';
import { buildRecapMessage, RECAP_MODEL, RECAP_SYSTEM, type RecapInput } from './recap.js';

const log = createLogger('recap');

// The developer waits through it in silence after the instant ack: past this the plain recap is said.
const RECAP_TIMEOUT_MS = 6_000;
const MAX_TOKENS = 200;

export type WriteRecap = (input: RecapInput) => Promise<string | null>;

interface CreateRecapWriterParams {
	apiKey: string | null;
	client?: Anthropic;
	timeoutMs?: number;
	now?: () => number;
}

export const createRecapWriter = ({
	apiKey,
	client,
	timeoutMs = RECAP_TIMEOUT_MS,
	now = Date.now,
}: CreateRecapWriterParams): WriteRecap => {
	const anthropic = client ?? (apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : null);

	return async (input) => {
		if (!anthropic) {
			return null;
		}

		const startedAt = now();
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeoutMs);

		try {
			const response = await anthropic.messages.create(
				{
					model: RECAP_MODEL,
					max_tokens: MAX_TOKENS,
					system: [{ type: 'text', text: RECAP_SYSTEM, cache_control: { type: 'ephemeral' } }],
					messages: [{ role: 'user', content: buildRecapMessage(input) }],
				},
				{ signal: abort.signal },
			);
			const block = response.content.find((part) => part.type === 'text');
			const text = block?.type === 'text' ? block.text.trim() : '';

			log.info('recap written', {
				sessions: input.sessions.length,
				ms: now() - startedAt,
				isEmpty: !text,
			});

			return text || null;
		} catch (error) {
			log.warn('recap not written', { error: String(error), ms: now() - startedAt });

			return null;
		} finally {
			clearTimeout(timer);
		}
	};
};
