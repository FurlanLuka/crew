// The link's transport: an SSH login that ends in `crew voice _attach` on the other machine.

import { createLogger } from '../log.js';
import type { OpenTransport } from './link.js';
import { forEachChunk } from './streams.js';

const log = createLogger('remote');

// The remote user's own shell parses this first (bash, zsh, fish alike read single quotes), then sh.
// crew may be on the login PATH or only in ~/.local/bin, where install.sh puts it.
export const REMOTE_COMMAND = `sh -lc 'command -v crew >/dev/null 2>&1 && exec crew voice _attach; exec "$HOME/.local/bin/crew" voice _attach'`;

export const buildSshArgv = (host: string): string[] => [
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
	REMOTE_COMMAND,
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
