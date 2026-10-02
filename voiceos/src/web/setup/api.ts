// Set up talks to crew over one endpoint: POST /api/crew with a typed command for one machine.
// Reads poll (useCrew); mutations report by exit code and crew's own line.
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { SetupCommand } from '../../crew/commands.js';

export interface CrewResult {
	code: number;
	stdout: string;
	stderr: string;
	json?: unknown;
}

// What the page shows when crew did not run at all (offline machine, old remote, timeout).
export interface CrewFailure {
	code: -1;
	stdout: '';
	stderr: string;
	reason: string;
	version?: string;
}

export type CrewReply = CrewResult | CrewFailure;

// A 200's body, as crew/api.ts sends it: anything else (a proxy's page, a half-read body) is not
// crew's answer, and is never read as one.
const crewResultSchema = z.object({
	code: z.number().int(),
	stdout: z.string(),
	stderr: z.string(),
	json: z.unknown().optional(),
});

// A failure's body: every field optional, a wrong type read as missing.
const failureSchema = z.object({
	reason: z.string().optional().catch(undefined),
	version: z.string().optional().catch(undefined),
	error: z.string().optional().catch(undefined),
});

export const INVALID_REPLY = 'invalid reply';

const describeFailure = (status: number, body: unknown): CrewFailure => {
	const parsed = failureSchema.safeParse(body);
	const { reason, version, error } = parsed.success ? parsed.data : {};

	return {
		code: -1,
		stdout: '',
		stderr: error ?? `crew's server answered ${status}`,
		reason: reason ?? String(status),
		...(version ? { version } : {}),
	};
};

// Pure: what the page makes of /api/crew's answer.
export const readCrewResponse = (status: number, body: unknown): CrewReply => {
	if (status === 202) {
		return { code: 0, stdout: '', stderr: '' };
	}

	if (status < 200 || status >= 300) {
		return describeFailure(status, body);
	}

	const result = crewResultSchema.safeParse(body);

	if (!result.success) {
		return {
			code: -1,
			stdout: '',
			stderr: "crew's server sent something that is not crew's answer",
			reason: INVALID_REPLY,
		};
	}

	const { json, ...rest } = result.data;

	return json === undefined ? rest : { ...rest, json };
};

export const runCrew = async (machine: string, command: SetupCommand): Promise<CrewReply> => {
	try {
		const response = await fetch('/api/crew', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ machine, command }),
		});
		const body: unknown = await response.json().catch(() => undefined);

		return readCrewResponse(response.status, body);
	} catch {
		return {
			code: -1,
			stdout: '',
			stderr: "crew's server is not answering",
			reason: 'network',
		};
	}
};

export const isOk = (reply: CrewReply | null | undefined): reply is CrewResult =>
	reply !== null && reply !== undefined && reply.code === 0;

// crew's last human line: what a mutation says it did, or why it refused. A document on stdout is
// crew's answer, not a line: then only its narration (stderr) speaks.
export const readCrewLine = (reply: CrewReply): string => {
	const hasDocument = 'json' in reply && reply.json !== undefined;
	const text = (reply.stderr.trim() || (hasDocument ? '' : reply.stdout.trim())).split('\n');

	return text.at(-1)?.trim() ?? '';
};

// Why crew did not answer, said whole: crew's line, and for a remote on an older release which one
// it runs (the link's line already says it updates from this Mac).
export const describeRefusal = (reply: CrewReply): string => {
	const line = readCrewLine(reply) || 'crew did not answer';

	return 'reason' in reply && reply.reason === 'remote_outdated' && reply.version
		? `${line} (it runs crew ${reply.version})`
		: line;
};

export interface UseCrew<T> {
	data: T | null;
	reply: CrewReply | null;
	isLoading: boolean;
	refresh: () => void;
}

interface UseCrewOptions {
	// Polled on progress pages (2 s): the page follows crew, it never guesses.
	pollMs?: number;
}

// One read, kept fresh. command: null to read nothing yet. The key is the command itself, so a new
// field value is a new read.
export const useCrew = <T>(
	machine: string,
	command: SetupCommand | null,
	{ pollMs }: UseCrewOptions = {},
): UseCrew<T> => {
	const [reply, setReply] = useState<CrewReply | null>(null);
	const [isLoading, setIsLoading] = useState(command !== null);
	const [tick, setTick] = useState(0);
	const key = command ? `${machine} ${JSON.stringify(command)}` : null;
	const commandRef = useRef(command);
	commandRef.current = command;

	useEffect(() => {
		const current = commandRef.current;

		if (!key || !current) {
			setReply(null);
			setIsLoading(false);

			return;
		}

		let isAlive = true;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const read = async () => {
			const next = await runCrew(machine, current);

			if (!isAlive) {
				return;
			}

			setReply(next);
			setIsLoading(false);

			if (pollMs) {
				timer = setTimeout(() => void read(), pollMs);
			}
		};

		setIsLoading(true);
		void read();

		return () => {
			isAlive = false;
			clearTimeout(timer);
		};
	}, [key, machine, pollMs, tick]);

	const refresh = useCallback(() => setTick((value) => value + 1), []);
	// crew answers JSON with a non-zero exit too (setup status: 2 running, 1 failed): the code says how.
	const data = reply && 'json' in reply && reply.json !== undefined ? (reply.json as T) : null;

	return { data, reply, isLoading, refresh };
};

// A mutation in flight and its last answer, for a form's button and its result line.
export const useCrewAction = (machine: string) => {
	const [isBusy, setIsBusy] = useState(false);
	const [last, setLast] = useState<CrewReply | null>(null);

	const run = useCallback(
		async (command: SetupCommand): Promise<CrewReply> => {
			setIsBusy(true);
			const reply = await runCrew(machine, command);
			setLast(reply);
			setIsBusy(false);

			return reply;
		},
		[machine],
	);

	return { run, isBusy, last, clear: () => setLast(null) };
};
