// POST /api/crew: Set up's one door to crew. The page sends {machine, command}; the command is
// checked against crew/commands.ts and run here or on that machine through its link. Logs carry the
// command's type, the machine, the exit code and the time — never an argument or an output, which
// can hold binding values, a bundle or a key.

import { z } from 'zod';
import { createLogger } from '../log.js';
import { LOCAL_MACHINE } from '../shared/machine-ref.js';
import { checkRequest } from '../gateway/auth.js';
import { CallFailure, type CallFailureReason } from '../remote/link.js';
import type { CrewRunResult, CrewRunner, CrewStarter } from './adapter.js';
import {
	parseSetupCommand,
	toCrewArgv,
	toCrewStdin,
	traitsOf,
	type SetupCommand,
} from './commands.js';

const log = createLogger('crew-api');

// A bundle is the largest thing the page sends.
const MAX_BODY_BYTES = 6 * 1024 * 1024;

export type CrewFailureReason = 'unknown_machine' | 'local_only' | CallFailureReason;

export type SetupReply =
	| { kind: 'ran'; result: CrewRunResult }
	// Replaces or removes this server: started, never waited for.
	| { kind: 'started' }
	| { kind: 'failed'; reason: CrewFailureReason; error: string; version?: string };

export type RunSetupCommand = (machine: string, command: SetupCommand) => Promise<SetupReply>;

interface RemoteLinkPort {
	runCommand: (command: SetupCommand) => Promise<CrewRunResult>;
}

export interface CreateSetupRunnerParams {
	runLocal: CrewRunner;
	startLocal: CrewStarter;
	getLink: (machine: string) => RemoteLinkPort | undefined;
}

const toFailure = (error: unknown): SetupReply =>
	error instanceof CallFailure
		? {
				kind: 'failed',
				reason: error.reason,
				error: error.message,
				...(error.version ? { version: error.version } : {}),
			}
		: { kind: 'failed', reason: 'offline', error: String(error) };

// One reading of a finished run, wherever it ran: a run crew was killed for (here, or on the remote
// that ran it) is a timeout, never an answer.
const toReply = (result: CrewRunResult, timeoutMs: number): SetupReply =>
	result.timedOut
		? {
				kind: 'failed',
				reason: 'timeout',
				error: `crew did not finish in ${Math.round(timeoutMs / 1000)} s`,
			}
		: { kind: 'ran', result };

export const createSetupRunner =
	({ runLocal, startLocal, getLink }: CreateSetupRunnerParams): RunSetupCommand =>
	async (machine, command) => {
		const traits = traitsOf(command);

		if (machine !== LOCAL_MACHINE) {
			const link = getLink(machine);

			if (!link) {
				return { kind: 'failed', reason: 'unknown_machine', error: `no machine ${machine}` };
			}

			if (traits.localOnly) {
				return {
					kind: 'failed',
					reason: 'local_only',
					error: `${command.type} runs only on this Mac`,
				};
			}

			try {
				return toReply(await link.runCommand(command), traits.timeoutMs);
			} catch (error) {
				return toFailure(error);
			}
		}

		if (traits.detached) {
			try {
				startLocal(toCrewArgv(command));
			} catch (error) {
				// The error's type only: a spawn error can quote the argv.
				log.warn('crew api start failed', {
					type: command.type,
					error: error instanceof Error ? error.name : typeof error,
				});

				return { kind: 'failed', reason: 'offline', error: 'crew could not be started' };
			}

			return { kind: 'started' };
		}

		const stdin = toCrewStdin(command);
		const result = await runLocal(toCrewArgv(command), {
			timeoutMs: traits.timeoutMs,
			...(stdin === undefined ? {} : { stdin }),
		});

		return toReply(result, traits.timeoutMs);
	};

const bodySchema = z.strictObject({
	machine: z.string().min(1).max(64),
	command: z.unknown(),
});

const STATUS_BY_REASON: Record<CrewFailureReason, number> = {
	unknown_machine: 404,
	local_only: 409,
	offline: 502,
	remote_outdated: 426,
	timeout: 504,
};

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response =>
	Response.json({ error, ...extra }, { status });

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
};

export interface HandleCrewRequestParams {
	request: Request;
	origins: string[];
	isAuthorized: boolean;
	runCrew: RunSetupCommand;
	now?: () => number;
}

// Every refusal before a command is known is logged the same way: the status and crew's reason,
// the type unknown, never the body.
const refuse = (status: number, text: string, extra: Record<string, string> = {}): Response => {
	log.warn('crew api refused', { status, why: text, type: 'unknown' });

	return fail(status, text, extra);
};

export const handleCrewRequest = async ({
	request,
	origins,
	isAuthorized,
	runCrew,
	now = Date.now,
}: HandleCrewRequestParams): Promise<Response> => {
	if (request.method !== 'POST') {
		return refuse(405, 'POST only');
	}

	const refusal = checkRequest({ origin: request.headers.get('origin'), origins, isAuthorized });

	if (refusal) {
		return refuse(refusal.status, refusal.text);
	}

	// A form post cannot set this: only a script on the page's own origin sends JSON.
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
		return refuse(415, 'expected application/json');
	}

	// Refused before it is read when the client says how big it is; checked again after, for a
	// chunked body that does not.
	if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
		return refuse(413, 'body too large');
	}

	const text = await request.text();

	if (text.length > MAX_BODY_BYTES) {
		return refuse(413, 'body too large');
	}

	const body = bodySchema.safeParse(parseJson(text));

	if (!body.success) {
		return refuse(400, 'expected {machine, command}', { reason: 'invalid' });
	}

	const parsed = parseSetupCommand(body.data.command);

	if (!parsed.ok) {
		log.warn('crew api invalid command', { machine: body.data.machine });

		return fail(400, parsed.error, { reason: 'invalid' });
	}

	const { command } = parsed;
	const { machine } = body.data;
	const startedAt = now();
	const reply = await runCrew(machine, command);
	const ms = now() - startedAt;

	switch (reply.kind) {
		case 'started':
			log.info('crew api started', { type: command.type, machine });

			return Response.json({ started: true }, { status: 202 });

		case 'failed':
			log.warn('crew api failed', { type: command.type, machine, reason: reply.reason, ms });

			return fail(STATUS_BY_REASON[reply.reason], reply.error, {
				reason: reply.reason,
				...(reply.version ? { version: reply.version } : {}),
			});

		case 'ran': {
			const { code, stdout, stderr } = reply.result;
			const json = traitsOf(command).json ? parseJson(stdout) : undefined;

			log.info('crew api', { type: command.type, machine, code, ms });

			return Response.json({ code, stdout, stderr, ...(json === undefined ? {} : { json }) });
		}
	}
};
