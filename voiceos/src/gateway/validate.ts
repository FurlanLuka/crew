import { z } from 'zod';
import { MAX_TEXT_CHARS, type ClientMessage } from '../shared/protocol.js';
import { isValidHost } from '../shared/machines.js';

const sampleRateSchema = z.number().int().min(8000).max(192000);
const refSchema = z.string().min(1).max(200);
const machineIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
const viewSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('active') }),
	z.object({ kind: z.literal('session'), ref: refSchema, from: z.literal('active').optional() }),
	z.object({ kind: z.literal('activate'), machine: machineIdSchema.optional() }),
	z.object({ kind: z.literal('settings') }),
]);

const actionSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('send'),
		ref: refSchema,
		text: z.string().min(1).max(MAX_TEXT_CHARS),
	}),
	z.object({ type: z.literal('cancel_queued'), ref: refSchema, queuedId: z.string() }),
	z.object({ type: z.literal('promote_queued'), ref: refSchema, queuedId: z.string() }),
	z.object({ type: z.literal('promote_all_queued'), ref: refSchema }),
	z.object({ type: z.literal('take_back'), ref: refSchema, id: z.string() }),
	z.object({ type: z.literal('held_line_heard'), ref: refSchema, id: z.string() }),
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
	z.object({ type: z.literal('answer_command'), askId: z.string(), isApproved: z.boolean() }),
	z.object({
		type: z.literal('answer_redirect'),
		askId: z.string(),
		isApproved: z.boolean(),
		message: z.string().max(4000).optional(),
	}),
	z.object({ type: z.literal('switch_view'), view: viewSchema }),
	// From the page: silent, so no announce. open: Set up's "Open Voice OS" shows it too.
	z.object({ type: z.literal('activate'), ref: refSchema, open: z.literal(true).optional() }),
	z.object({ type: z.literal('deactivate'), ref: refSchema }),
	z.object({ type: z.literal('interrupt'), ref: refSchema }),
	z.object({ type: z.literal('allow_denied'), denialId: z.string() }),
	z.object({ type: z.literal('dismiss_denial'), denialId: z.string() }),
	z.object({ type: z.literal('dev_start'), ref: refSchema }),
	z.object({ type: z.literal('dev_stop'), ref: refSchema }),
	z.object({ type: z.literal('dev_restart'), ref: refSchema }),
	z.object({ type: z.literal('fix_dev'), ref: refSchema }),
	z.object({ type: z.literal('dismiss_dev_offer') }),
	z.object({
		type: z.literal('add_machine'),
		host: z.string().refine(isValidHost),
		name: z.string().max(60).optional(),
	}),
	z.object({
		type: z.literal('rename_machine'),
		id: machineIdSchema,
		name: z.string().min(1).max(60),
	}),
	z.object({ type: z.literal('remove_machine'), id: machineIdSchema }),
	z.object({ type: z.literal('rename_session'), ref: refSchema, name: z.string().max(60) }),
	z.object({ type: z.literal('go_back') }),
	z.object({ type: z.literal('play_meanwhile') }),
	z.object({
		type: z.literal('set_languages'),
		languages: z.array(z.string().max(8)).max(20),
	}),
	z.object({ type: z.literal('offer_switch'), ref: refSchema }),
	z.object({
		type: z.literal('ask_which'),
		ref: refSchema,
		screen: refSchema,
		text: z.string().min(1).max(MAX_TEXT_CHARS),
	}),
	z.object({ type: z.literal('settle_target'), at: z.number(), toTarget: z.boolean() }),
]);

const clientMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('action'), action: actionSchema }),
	z.object({ type: z.literal('utterance'), text: z.string().min(1).max(MAX_TEXT_CHARS) }),
	z.object({
		type: z.literal('ptt_start'),
		sampleRate: sampleRateSchema.optional(),
		dictation: z.literal(true).optional(),
	}),
	z.object({ type: z.literal('ptt_stop') }),
	z.object({ type: z.literal('ptt_cancel') }),
	z.object({
		type: z.literal('simulate_speech'),
		text: z.string().min(1).max(MAX_TEXT_CHARS),
		holdMs: z.number().int().min(0).max(30_000).optional(),
	}),
	z.object({
		type: z.literal('listen_start'),
		sampleRate: sampleRateSchema,
		mode: z.enum(['on-demand', 'hands-free']).optional(),
	}),
	z.object({ type: z.literal('listen_stop') }),
	z.object({ type: z.literal('audio_done'), id: z.string() }),
	z.object({ type: z.literal('discord_listen'), mode: z.enum(['on-demand', 'hands-free']) }),
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
