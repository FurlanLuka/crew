// The link's transport: an SSH login that ends in `crew voice _attach` on the other machine.

import { createLogger } from '../log.js';
import type { OpenTransport } from './link.js';
import { forEachChunk } from './streams.js';

const log = createLogger('remote');

// The remote user's own shell parses this first (bash, zsh, fish alike read single quotes), then sh.
// crew may be on the login PATH or only in ~/.local/bin, where install.sh puts it. The same fallback
// is copied in crew/internal/voice/remote_query.go (RemoteCrewCommand): the two change together.
const buildRemoteCrewCommand = (args: string): string =>
	`sh -lc 'command -v crew >/dev/null 2>&1 && exec crew ${args}; exec "$HOME/.local/bin/crew" ${args}'`;

export const REMOTE_COMMAND = buildRemoteCrewCommand('voice _attach');
export const REMOTE_UPDATE_COMMAND = buildRemoteCrewCommand('update');

export const buildSshArgv = (host: string, command = REMOTE_COMMAND): string[] => [
	'ssh',
	// Never a password prompt: there is no terminal to type it in.
	'-o',
	'BatchMode=yes',
	'-o',
	'ConnectTimeout=10',
	'-o',
	'ServerAliveInterval=15',
	'-o',
	'ServerAliveCountMax=3',
	'--',
	host,
	command,
];

const STDERR_KEPT = 4_000;
const READ_GRACE_MS = 1_500;

// VOICEOS_REMOTE_EXEC (tests and QA): a shell command run instead of ssh, the host in REMOTE_HOST.
export const openSshTransport: OpenTransport = (host, { onData, onExit }) => {
	const override = process.env.VOICEOS_REMOTE_EXEC;
	const argv = override ? ['sh', '-c', override] : buildSshArgv(host);

	log.info('spawn', { host, command: override ? 'override' : 'ssh' });

	const child = Bun.spawn(argv, {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, REMOTE_HOST: host },
	});
	let stderr = '';

	const stdoutRead = (async () => {
		await forEachChunk(child.stdout, onData);
	})();

	const stderrRead = (async () => {
		const decoder = new TextDecoder();

		await forEachChunk(child.stderr, (chunk) => {
			stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-STDERR_KEPT);
		});
	})();

	// Everything it said comes first (a refusal on stdout, its reason on stderr), then its exit. An
	// ssh ControlMaster left in the background can hold the pipes open past the exit: after the
	// exit, the reads get a short grace, never forever.
	const reads = Promise.all([stdoutRead.catch(() => undefined), stderrRead.catch(() => undefined)]);

	void child.exited.then(async (code) => {
		await Promise.race([reads, new Promise((resolve) => setTimeout(resolve, READ_GRACE_MS))]);
		log.info('exit', { host, code });
		onExit(code, stderr);
	});

	return {
		write: (text) => {
			try {
				child.stdin.write(text);
				void child.stdin.flush();
			} catch (error) {
				log.warn('write failed', { host, error: String(error) });
			}
		},
		close: () => child.kill(),
	};
};

export interface RemoteUpdateResult {
	code: number | null;
	// What it printed, both streams, the end kept: crew's own last line says what went wrong.
	output: string;
	isTimedOut: boolean;
}

export type UpdateRemote = (host: string) => Promise<RemoteUpdateResult>;

// A download and an install: minutes at worst, never forever.
const UPDATE_TIMEOUT_MS = 5 * 60_000;

// crew update on that machine, over the same SSH as the link. VOICEOS_REMOTE_UPDATE_EXEC (tests and QA)
// runs a shell command instead of ssh.
export const updateRemoteCrew = async (
	host: string,
	timeoutMs = UPDATE_TIMEOUT_MS,
): Promise<RemoteUpdateResult> => {
	const override = process.env.VOICEOS_REMOTE_UPDATE_EXEC;
	const argv = override ? ['sh', '-c', override] : buildSshArgv(host, REMOTE_UPDATE_COMMAND);
	const startedAt = Date.now();

	log.info('update spawn', { host, command: override ? 'override' : 'ssh' });

	const child = Bun.spawn(argv, {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, REMOTE_HOST: host },
	});
	let output = '';

	// One decoder per stream: a character split across chunks never borrows the other stream's bytes.
	const keepFrom = (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();

		return forEachChunk(stream, (chunk) => {
			output = (output + decoder.decode(chunk, { stream: true })).slice(-STDERR_KEPT);
		}).catch(() => undefined);
	};

	const reads = Promise.all([keepFrom(child.stdout), keepFrom(child.stderr)]);
	// As with the link: a ControlMaster can hold the pipes past the exit, so the reads get a grace.
	const exited = child.exited.then(async (code) => {
		await Promise.race([reads, new Promise((resolve) => setTimeout(resolve, READ_GRACE_MS))]);

		return { code, isTimedOut: false };
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<{ code: null; isTimedOut: true }>((resolve) => {
		timer = setTimeout(() => {
			child.kill();
			resolve({ code: null, isTimedOut: true });
		}, timeoutMs);
	});
	const { code, isTimedOut } = await Promise.race([exited, timedOut]);

	clearTimeout(timer);
	log.info('update exit', { host, code, isTimedOut, ms: Date.now() - startedAt });

	return { code, output, isTimedOut };
};
