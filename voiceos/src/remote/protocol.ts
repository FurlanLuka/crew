// What a main and a remote say to each other over the SSH link: one JSON object per line.
// The envelope is checked here; what a remote reports inside it (an Observation) is checked against
// the types a remote may send, and trusted beyond that because both sides run the same release.

import { z } from 'zod';
import type { AsideStatus, Observation, PendingAsk, WorktreeInfo } from '../shared/protocol.js';
import type { HandsEffect } from './mapping.js';

// Both ends of a link: the main pings this often, and either end gives up on a side this silent
// (an SSH link can look open long after the network under it went).
export const PING_MS = 15_000;
export const SILENCE_LIMIT_MS = 45_000;

export interface LastTurn {
	id: string;
	text: string;
	costUsd: number;
	head: string | null;
}

export interface SessionSnapshot {
	ref: string;
	status: 'idle' | 'running' | 'starting';
	lastTurn: LastTurn | null;
}

export interface AsideInFlight {
	ref: string;
	itemId: string;
}

// Everything the main needs to line its picture up with the remote's after any (re)connect.
export interface Snapshot {
	worktrees: WorktreeInfo[];
	sessions: SessionSnapshot[];
	asks: PendingAsk[];
	asides: AsideInFlight[];
}

export interface SequencedEffect {
	seq: number;
	effect: HandsEffect;
}

export type MainMessage =
	// runId: this main process; pending: effects sent before and not acknowledged, applied first.
	| { type: 'hello'; version: string; mainId: string; runId: string; pending: SequencedEffect[] }
	| { type: 'effect'; seq: number; effect: HandsEffect }
	| { type: 'call'; id: number; method: 'crew'; args: string[]; timeoutMs?: number }
	| { type: 'ping' };

export type RemoteMessage =
	| { type: 'hello'; version: string; host: string; snapshot: Snapshot }
	| { type: 'refused'; reason: 'held' | 'version'; detail: string }
	| { type: 'ack'; upTo: number }
	| { type: 'input'; input: Observation }
	| { type: 'worktrees'; worktrees: WorktreeInfo[] }
	// An image's bytes, sent before the input that names it.
	| { type: 'media'; name: string; base64: string }
	| { type: 'result'; id: number; ok: true; value: CrewCallResult }
	| { type: 'result'; id: number; ok: false; error: string }
	| { type: 'pong' };

export interface CrewCallResult {
	code: number;
	stdout: string;
	stderr: string;
}

// What a remote may report. Anything else (limits, narration, the cockpit's own inputs) is dropped.
export const REMOTE_OBSERVATIONS = new Set<Observation['type']>([
	'session_started',
	'turn_started',
	'text_delta',
	'assistant_text',
	'tool',
	'tool_result',
	'diff',
	'image',
	'doc',
	'turn_ended',
	'denied',
	'ask_opened',
	'ask_closed',
	'worker_exited',
	'history_restored',
	'subagent_started',
	'subagent_step',
	'subagent_backgrounded',
	'subagent_ended',
	'aside_settled',
	'conversation_reset',
	'compacting',
	'session_notice',
]);

const looseObject = z.object({}).passthrough();
const worktreeSchema = z.object({
	ref: z.string().min(1).max(200),
	label: z.string().max(200),
	branch: z.string().max(400),
	cwd: z.string().max(4000),
	dirs: z.array(z.string().max(4000)).max(50),
	isPinned: z.boolean(),
});

const snapshotSchema = z.object({
	worktrees: z.array(worktreeSchema).max(500),
	sessions: z
		.array(
			z.object({
				ref: z.string().min(1).max(200),
				status: z.enum(['idle', 'running', 'starting']),
				lastTurn: z
					.object({
						id: z.string().max(200),
						text: z.string(),
						costUsd: z.number(),
						head: z.string().max(200).nullable(),
					})
					.nullable(),
			}),
		)
		.max(500),
	asks: z.array(looseObject.extend({ id: z.string(), ref: z.string(), kind: z.string() })).max(500),
	asides: z.array(z.object({ ref: z.string(), itemId: z.string() })).max(500),
});

// A plain union: a result is two shapes under one type (answered, or failed).
const remoteSchema = z.union([
	z.object({
		type: z.literal('hello'),
		version: z.string(),
		host: z.string(),
		snapshot: snapshotSchema,
	}),
	z.object({
		type: z.literal('refused'),
		reason: z.enum(['held', 'version']),
		detail: z.string().max(500),
	}),
	z.object({ type: z.literal('ack'), upTo: z.number().int().nonnegative() }),
	z.object({ type: z.literal('input'), input: looseObject.extend({ type: z.string() }) }),
	z.object({ type: z.literal('worktrees'), worktrees: z.array(worktreeSchema).max(500) }),
	z.object({
		type: z.literal('media'),
		name: z.string().max(200),
		base64: z.string(),
	}),
	z.object({
		type: z.literal('result'),
		id: z.number().int(),
		ok: z.literal(true),
		value: z.object({ code: z.number(), stdout: z.string(), stderr: z.string() }),
	}),
	z.object({
		type: z.literal('result'),
		id: z.number().int(),
		ok: z.literal(false),
		error: z.string(),
	}),
	z.object({ type: z.literal('pong') }),
]);

const sequencedSchema = z.object({
	seq: z.number().int().positive(),
	effect: looseObject.extend({ type: z.string(), ref: z.string() }),
});

const mainSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('hello'),
		version: z.string(),
		mainId: z.string().min(1).max(100),
		runId: z.string().min(1).max(100),
		pending: z.array(sequencedSchema).max(10_000),
	}),
	z.object({
		type: z.literal('effect'),
		seq: z.number().int().positive(),
		effect: sequencedSchema.shape.effect,
	}),
	z.object({
		type: z.literal('call'),
		id: z.number().int(),
		method: z.literal('crew'),
		args: z.array(z.string().max(1000)).max(20),
		timeoutMs: z.number().int().positive().max(300_000).optional(),
	}),
	z.object({ type: z.literal('ping') }),
]);

export type ParsedLine<T> = { ok: true; message: T } | { ok: false; error: string };

const parseWith = <T>(schema: z.ZodType, line: string): ParsedLine<T> => {
	let value: unknown;

	try {
		value = JSON.parse(line);
	} catch {
		return { ok: false, error: 'not JSON' };
	}

	const result = schema.safeParse(value);

	if (!result.success) {
		return { ok: false, error: result.error.issues[0]?.message ?? 'invalid message' };
	}

	if (
		(result.data as { type: string }).type === 'input' &&
		!REMOTE_OBSERVATIONS.has((result.data as { input: Observation }).input.type)
	) {
		return {
			ok: false,
			error: `a remote may not send ${(result.data as { input: Observation }).input.type}`,
		};
	}

	return { ok: true, message: result.data as T };
};

export const parseRemoteLine = (line: string): ParsedLine<RemoteMessage> =>
	parseWith<RemoteMessage>(remoteSchema, line);

export const parseMainLine = (line: string): ParsedLine<MainMessage> =>
	parseWith<MainMessage>(mainSchema, line);

export const encodeLine = (message: MainMessage | RemoteMessage): string =>
	`${JSON.stringify(message)}\n`;

// Splits a byte stream into lines: chunks may end mid-line or mid-character, and a login shell may
// print a banner before the first message (the caller skips what does not parse).
export const createLineDecoder = (onLine: (line: string) => void) => {
	const decoder = new TextDecoder();
	let buffer = '';

	return (chunk: Uint8Array | string): void => {
		buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

		let newline = buffer.indexOf('\n');

		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();

			buffer = buffer.slice(newline + 1);

			if (line) {
				onLine(line);
			}

			newline = buffer.indexOf('\n');
		}
	};
};
