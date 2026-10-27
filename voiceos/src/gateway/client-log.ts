import { createLogger } from '../log.js';
import type { GatewayClientMessage } from '../shared/protocol.js';

const log = createLogger('client');

export const MAX_CLIENT_LOG_FIELDS_BYTES = 2048;

// The log line's own keys: a page's field may not pass itself off as one of them.
const RESERVED_KEYS = new Set(['ts', 'level', 'cat', 'msg', 'client', 'phone', 'area']);

type ClientLog = Extract<GatewayClientMessage, { type: 'client_log' }>;

export interface ClientLogSource {
	client: string;
	phone: string | null;
}

// The page's own category goes in as `area`: `cat` is the line's, always "client", so
// `crew server logs` finds every page line under one category.
export const buildClientLogFields = (
	message: ClientLog,
	{ client, phone }: ClientLogSource,
): Record<string, unknown> => {
	const base = { client, phone, area: message.cat };

	if (!message.fields) {
		return base;
	}

	const size = Buffer.byteLength(JSON.stringify(message.fields));

	if (size > MAX_CLIENT_LOG_FIELDS_BYTES) {
		return { ...base, fieldsDropped: size };
	}

	const fields = Object.fromEntries(
		Object.entries(message.fields).filter(([key]) => !RESERVED_KEYS.has(key)),
	);

	return { ...fields, ...base };
};

export const writeClientLog = (message: ClientLog, source: ClientLogSource): void => {
	log[message.level](message.msg, buildClientLogFields(message, source));
};
