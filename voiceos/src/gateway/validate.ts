import { z } from 'zod';
import type { ClientMessage } from '../shared/protocol.js';

const sampleRateSchema = z.number().int().min(8000).max(192000);
const refSchema = z.string().min(1).max(200);
const viewSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('grid') }),
	z.object({ kind: z.literal('session'), ref: refSchema }),
]);

const actionSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('send'), ref: refSchema, text: z.string().min(1).max(20_000) }),
	z.object({ type: z.literal('cancel_queued'), ref: refSchema, queuedId: z.string() }),
	z.object({
		type: z.literal('answer_permission'),
		askId: z.string(),
		decision: z.enum(['allow', 'always', 'deny']),
		message: z.string().max(2000).optional(),
	}),
	z.object({
		type: z.literal('answer_question'),
		askId: z.string(),
		answers: z.record(z.string(), z.string().max(2000)),
	}),
	z.object({
		type: z.literal('answer_plan'),
		askId: z.string(),
		isApproved: z.boolean(),
		message: z.string().max(4000).optional(),
	}),
	z.object({ type: z.literal('switch_view'), view: viewSchema }),
	z.object({ type: z.literal('start_session'), ref: refSchema }),
	z.object({ type: z.literal('stop_session'), ref: refSchema }),
	z.object({ type: z.literal('interrupt'), ref: refSchema }),
	z.object({ type: z.literal('allow_denied'), denialId: z.string() }),
	z.object({ type: z.literal('dismiss_denial'), denialId: z.string() }),
	z.object({ type: z.literal('dismiss_needs_user'), ref: refSchema }),
	z.object({ type: z.literal('pin_topic'), ref: refSchema, topic: z.string().max(200) }),
	z.object({ type: z.literal('dev_start'), ref: refSchema }),
	z.object({ type: z.literal('dev_stop'), ref: refSchema }),
	z.object({ type: z.literal('dev_restart'), ref: refSchema }),
	z.object({ type: z.literal('fix_dev'), ref: refSchema }),
	z.object({ type: z.literal('dismiss_dev_offer') }),
]);

const clientMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('action'), action: actionSchema }),
	z.object({ type: z.literal('utterance'), text: z.string().min(1).max(20_000) }),
	z.object({ type: z.literal('ptt_start'), sampleRate: sampleRateSchema.optional() }),
	z.object({ type: z.literal('ptt_stop') }),
	z.object({ type: z.literal('listen_start'), sampleRate: sampleRateSchema }),
	z.object({ type: z.literal('listen_stop') }),
	z.object({ type: z.literal('audio_done'), id: z.string() }),
]) satisfies z.ZodType<ClientMessage>;

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; error: string };

interface ParsedJson {
	value: unknown;
}

const parseJson = (raw: string): ParsedJson | null => {
	try {
		return { value: JSON.parse(raw) };
	} catch {
		// Not JSON: the caller reports it to the client.
		return null;
	}
};

export const parseClientMessage = (raw: string): ParseResult => {
	const parsedJson = parseJson(raw);

	if (!parsedJson) {
		return { ok: false, error: 'invalid JSON' };
	}

	const result = clientMessageSchema.safeParse(parsedJson.value);

	if (!result.success) {
		return { ok: false, error: result.error.issues[0]?.message ?? 'invalid message' };
	}

	return { ok: true, message: result.data as ClientMessage };
};
