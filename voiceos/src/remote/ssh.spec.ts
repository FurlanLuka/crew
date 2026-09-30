import { describe, expect, it } from 'bun:test';
import {
	REMOTE_COMMAND,
	REMOTE_UPDATE_COMMAND,
	buildSshArgv,
	openSshTransport,
	updateRemoteCrew,
} from './ssh.js';
import { Store } from '../state/store.js';
import { MachineLinks } from './links.js';
import { until } from '../../test/support/link.js';
import { configureLog } from '../log.js';

configureLog({ quiet: true });

describe('buildSshArgv', () => {
	it('never prompts, gives up on a dead link, and ends option parsing before the host', () => {
		expect(buildSshArgv('dev@vm1')).toEqual([
			'ssh',
			'-o',
			'BatchMode=yes',
			'-o',
			'ConnectTimeout=10',
			'-o',
			'ServerAliveInterval=15',
			'-o',
			'ServerAliveCountMax=3',
			'--',
			'dev@vm1',
			REMOTE_COMMAND,
		]);
	});

	it('the remote command → crew on the login PATH, else ~/.local/bin', () => {
		expect(REMOTE_COMMAND).toBe(
			`sh -lc 'command -v crew >/dev/null 2>&1 && exec crew voice _attach; exec "$HOME/.local/bin/crew" voice _attach'`,
		);
	});

	it('an update → crew update there, found the same way, over the same options', () => {
		expect(REMOTE_UPDATE_COMMAND).toBe(
			`sh -lc 'command -v crew >/dev/null 2>&1 && exec crew update; exec "$HOME/.local/bin/crew" update'`,
		);
		expect(buildSshArgv('dev@vm1', REMOTE_UPDATE_COMMAND).at(-1)).toBe(REMOTE_UPDATE_COMMAND);
		expect(buildSshArgv('dev@vm1', REMOTE_UPDATE_COMMAND).slice(0, -1)).toEqual(
			buildSshArgv('dev@vm1').slice(0, -1),
		);
	});
});

describe('updateRemoteCrew', () => {
	const withOverride = async <T>(command: string, run: () => Promise<T>): Promise<T> => {
		const saved = process.env.VOICEOS_REMOTE_UPDATE_EXEC;

		process.env.VOICEOS_REMOTE_UPDATE_EXEC = command;

		try {
			return await run();
		} finally {
			if (saved === undefined) {
				delete process.env.VOICEOS_REMOTE_UPDATE_EXEC;
			} else {
				process.env.VOICEOS_REMOTE_UPDATE_EXEC = saved;
			}
		}
	};

	it('exits while something it started holds the pipes (a ControlMaster) → answered anyway', async () => {
		const startedAt = Date.now();
		const result = await withOverride('sleep 30 & echo "crew updated"; exit 0', () =>
			updateRemoteCrew('vm1'),
		);

		expect(result).toMatchObject({ code: 0, isTimedOut: false });
		expect(result.output).toContain('crew updated');
		expect(Date.now() - startedAt).toBeLessThan(10_000);
	});

	it('never finishes → given up on, and said to have timed out', async () => {
		const result = await withOverride('echo "Downloading…"; sleep 30', () =>
			updateRemoteCrew('vm1', 200),
		);

		expect(result).toMatchObject({ code: null, isTimedOut: true });
	});

	it('a real process: its exit code, and what it printed on either stream', async () => {
		const saved = process.env.VOICEOS_REMOTE_UPDATE_EXEC;

		process.env.VOICEOS_REMOTE_UPDATE_EXEC =
			'echo "Downloading crew for $REMOTE_HOST"; echo "Error: disk full" >&2; exit 3';

		try {
			const result = await updateRemoteCrew('vm1');

			expect(result.code).toBe(3);
			expect(result.output).toContain('Downloading crew for vm1');
			expect(result.output.trim().endsWith('Error: disk full')).toBe(true);
		} finally {
			if (saved === undefined) {
				delete process.env.VOICEOS_REMOTE_UPDATE_EXEC;
			} else {
				process.env.VOICEOS_REMOTE_UPDATE_EXEC = saved;
			}
		}
	});
});

describe('openSshTransport', () => {
	it('a real process: what it prints reaches the link, and its last words explain its exit', async () => {
		const saved = process.env.VOICEOS_REMOTE_EXEC;

		process.env.VOICEOS_REMOTE_EXEC =
			'printf "%s\\n" "{\\"type\\":\\"pong\\"}"; echo "crew-remote-error: cockpit-running" >&2; exit 4';

		try {
			const received: string[] = [];
			const exited = Promise.withResolvers<{ code: number | null; stderr: string }>();

			openSshTransport('vm1', {
				onData: (chunk) => received.push(new TextDecoder().decode(chunk as Uint8Array)),
				onExit: (code, stderr) => exited.resolve({ code, stderr }),
			});

			const { code, stderr } = await exited.promise;

			expect(received.join('')).toBe('{"type":"pong"}\n');
			expect(code).toBe(4);
			expect(stderr).toBe('crew-remote-error: cockpit-running\n');
		} finally {
			if (saved === undefined) {
				delete process.env.VOICEOS_REMOTE_EXEC;
			} else {
				process.env.VOICEOS_REMOTE_EXEC = saved;
			}
		}
	});
});

describe('a refusal over a real process', () => {
	it('the remote refuses and exits → the machine shows why, not "the link closed"', async () => {
		const saved = process.env.VOICEOS_REMOTE_EXEC;
		const refused = JSON.stringify({
			type: 'refused',
			reason: 'held',
			detail: 'Another Voice OS drives this machine.',
		});

		process.env.VOICEOS_REMOTE_EXEC = `printf '%s\\n' '${refused}'; exit 0`;

		const store = new Store();
		const links = new MachineLinks({
			version: 'test',
			mainId: 'main-1',
			runId: 'run-1',
			open: openSshTransport,
			updateRemote: async () => ({ code: 0, output: '', isTimedOut: false }),
			setup: { ref: 'setup', label: 'setup', branch: '', cwd: '/h', dirs: [], isPinned: true },
			getState: () => store.state,
			dispatch: (input) => store.dispatch(input),
			storeMedia: () => true,
			say: () => undefined,
			handleLocal: () => undefined,
			retryMs: 60_000,
		});

		try {
			store.subscribe(() => queueMicrotask(() => links.sync()));
			store.dispatch({
				type: 'machines',
				machines: [{ id: 'vm1', host: 'vm1', name: 'Build box' }],
			});
			await until(() => store.state.machines.vm1?.status === 'error', 'refused');

			expect(store.state.machines.vm1?.detail).toBe('Another Voice OS drives this machine.');
		} finally {
			links.stopAll();

			if (saved === undefined) {
				delete process.env.VOICEOS_REMOTE_EXEC;
			} else {
				process.env.VOICEOS_REMOTE_EXEC = saved;
			}
		}
	});
});

describe('a process that leaves its pipes held open', () => {
	it('ssh exits while something it started still holds the pipes → the exit is reported anyway', async () => {
		const saved = process.env.VOICEOS_REMOTE_EXEC;

		process.env.VOICEOS_REMOTE_EXEC = 'sleep 30 >&2 & exit 0';

		try {
			const exited = Promise.withResolvers<number | null>();
			const transport = openSshTransport('vm1', {
				onData: () => undefined,
				onExit: (code) => exited.resolve(code),
			});
			const startedAt = Date.now();

			expect(await exited.promise).toBe(0);
			expect(Date.now() - startedAt).toBeLessThan(5_000);
			transport.close();
		} finally {
			if (saved === undefined) {
				delete process.env.VOICEOS_REMOTE_EXEC;
			} else {
				process.env.VOICEOS_REMOTE_EXEC = saved;
			}
		}
	});
});
