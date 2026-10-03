// `voiceos remote serve`: this machine's sessions, driven by a main over a link (crew server remote
// runs it in tmux). `voiceos remote attach`: what `crew voice _attach` execs at the end of an SSH
// login, bridging that SSH session's stdio to the serving daemon's socket.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'bun';
import { resolvePaths } from '../config.js';
import { CrewAdapter, spawnRunner } from '../crew/adapter.js';
import { configureLog, createLogger } from '../log.js';
import { readGitHead } from '../narrator/turn.js';
import { resolveClaudeBin, isCompiled } from '../sessions/claude-bin.js';
import { loadTranscript, restoreHistory } from '../sessions/history.js';
import { SessionManager } from '../sessions/manager.js';
import { readMediaBytes } from '../sessions/media.js';
import { ATTACHMENTS_KEPT_MS, sweepAttachments } from '../sessions/attachments.js';
import { loadRegistry } from '../sessions/registry.js';
import { SETUP_ORIENTATION, SETUP_REF, createSetupWorktree } from '../sessions/setup-session.js';
import { VERSION } from '../version.js';
import { RemoteHost } from './host.js';
import { createLineDecoder } from './protocol.js';
import { listenQuerySocket } from './query-socket.js';
import { createSocketWriter, type SocketWriter } from './socket-writer.js';
import { forEachChunk } from './streams.js';

const WORKTREE_POLL_MS = 10_000;
const SILENCE_CHECK_MS = 5_000;

export interface RemotePaths {
	dir: string;
	socket: string;
	// crew server logs (debug-notes, notes) here, asking the main through this daemon's link.
	querySocket: string;
	daemonFile: string;
	registryFile: string;
	mediaDir: string;
	attachmentsDir: string;
	logFile: string;
}

// Its own folder: this machine may also have been a main once, and the two must never share files.
export const resolveRemotePaths = (voiceDir: string): RemotePaths => {
	const dir = join(voiceDir, 'remote');

	return {
		dir,
		socket: join(dir, 'remote.sock'),
		querySocket: join(dir, 'query.sock'),
		daemonFile: join(dir, 'daemon.json'),
		registryFile: join(dir, 'sessions.json'),
		mediaDir: join(dir, 'media'),
		attachmentsDir: join(dir, 'attachments'),
		logFile: join(dir, 'logs', 'voiceos-remote.log'),
	};
};

interface SocketData {
	receive: ((chunk: Uint8Array) => void) | null;
	closed: (() => void) | null;
	writer: SocketWriter;
}

const serve = async (): Promise<void> => {
	const paths = resolvePaths();
	const remote = resolveRemotePaths(paths.voiceDir);

	mkdirSync(remote.dir, { recursive: true, mode: 0o700 });
	chmodSync(remote.dir, 0o700);
	configureLog({ file: remote.logFile });

	const log = createLogger('remote');
	const crew = new CrewAdapter();
	const claudeBin = resolveClaudeBin({
		override: process.env.VOICEOS_CLAUDE_BIN,
		compiled: isCompiled(),
		which: (command) => Bun.which(command),
	});
	const startedAt = new Date().toISOString();

	const writeDaemonFile = (isBusy: boolean): void => {
		writeFileSync(
			remote.daemonFile,
			JSON.stringify(
				{ pid: process.pid, version: VERSION, busy: isBusy, started_at: startedAt },
				null,
				2,
			),
			{ mode: 0o600 },
		);
	};

	// Files the main sent ahead of a session's words; old ones go, as on the main.
	const sweptAttachments = sweepAttachments({
		dir: remote.attachmentsDir,
		maxAgeMs: ATTACHMENTS_KEPT_MS,
		now: Date.now(),
	});

	if (sweptAttachments > 0) {
		log.info('old attachments removed', { count: sweptAttachments });
	}

	const listWorktrees = async () => [
		createSetupWorktree(paths.home),
		...(await crew.listWorktrees()),
	];
	const host = new RemoteHost({
		version: VERSION,
		host: hostname(),
		createManager: ({ readSession, emit }) =>
			new SessionManager({
				readSession,
				emit,
				registryFile: remote.registryFile,
				home: paths.home,
				mediaDir: remote.mediaDir,
				attachmentsDir: remote.attachmentsDir,
				claudeBin: claudeBin ?? undefined,
				fetchOrientation: (ref) =>
					ref === SETUP_REF ? Promise.resolve(SETUP_ORIENTATION) : crew.fetchOrientation(ref),
			}),
		listWorktrees,
		runCrew: spawnRunner,
		readGitHead,
		readMedia: (name) => readMediaBytes(name, remote.mediaDir),
		restoreHistory: async (dispatch) => {
			const worktrees = await listWorktrees().catch(() => [createSetupWorktree(paths.home)]);
			const infoOf = (ref: string) => worktrees.find((info) => info.ref === ref);

			await restoreHistory({
				dispatch,
				sessions: loadRegistry(remote.registryFile),
				getCwd: (ref) => infoOf(ref)?.cwd ?? null,
				getImageSource: (ref) => infoOf(ref),
				mediaDir: remote.mediaDir,
				loadMessages: loadTranscript,
			});
		},
		onBusyChanged: writeDaemonFile,
	});

	await host.refreshWorktrees();

	// A socket left by a daemon that died would refuse the new one.
	rmSync(remote.socket, { force: true });

	const encoder = new TextEncoder();
	const server = Bun.listen<SocketData>({
		unix: remote.socket,
		socket: {
			open(socket) {
				socket.data = { receive: null, closed: null, writer: createSocketWriter(socket) };

				const link = host.connect({
					write: (text) => socket.data.writer.write(encoder.encode(text)),
					close: () => socket.end(),
				});
				const decode = createLineDecoder(link.receive);

				socket.data.receive = decode;
				socket.data.closed = link.closed;
			},
			data(socket, chunk) {
				socket.data.receive?.(chunk);
			},
			drain(socket) {
				socket.data.writer.drain();
			},
			close(socket) {
				socket.data.closed?.();
			},
			error(socket, error) {
				log.warn('link error', { error: String(error) });
				socket.data.closed?.();
			},
		},
	});

	// Only this user may drive these sessions.
	chmodSync(remote.socket, 0o600);

	const querySocket = listenQuerySocket({ path: remote.querySocket, askMain: host.query });

	writeDaemonFile(false);
	log.info('remote serving', { version: VERSION, socket: remote.socket, pid: process.pid });

	const pollTimer = setInterval(() => void host.refreshWorktrees(), WORKTREE_POLL_MS);
	const silenceTimer = setInterval(() => host.dropSilent(), SILENCE_CHECK_MS);

	const shutdown = (signal: string): void => {
		log.info('remote shutting down', { signal });
		clearInterval(pollTimer);
		clearInterval(silenceTimer);
		host.stopAll();
		server.stop(true);
		querySocket.stop();
		rmSync(remote.socket, { force: true });
		rmSync(remote.daemonFile, { force: true });
		process.exit(0);
	};

	process.on('SIGHUP', () => shutdown('SIGHUP'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
};

// Bridges stdin/stdout (the SSH session) to the daemon's socket, and ends with either side.
const attach = async (): Promise<void> => {
	const paths = resolvePaths();
	const remote = resolveRemotePaths(paths.voiceDir);
	// No daemon listening (it stopped, or never started): said the way the main reads a refusal,
	// never as a runtime crash. Exit 5 is crew's attachNoDaemon (cmd_voice_remote.go).
	const socket = await Bun.connect<SocketData>({
		unix: remote.socket,
		socket: {
			open(opened) {
				opened.data = { receive: null, closed: null, writer: createSocketWriter(opened) };
			},
			data(_socket, chunk) {
				process.stdout.write(chunk);
			},
			drain(drained) {
				drained.data.writer.drain();
			},
			close() {
				// What the daemon said last (a refusal) reaches the main before this process ends.
				process.stdout.write('', () => process.exit(0));
			},
			error(_socket, error) {
				process.stderr.write(`crew-remote-error: link: ${String(error)}\n`);
				process.exit(1);
			},
		},
	}).catch((error: unknown) => {
		process.stderr.write(`crew-remote-error: daemon-not-listening: ${String(error)}\n`);
		process.exit(5);
	});

	await forEachChunk(Bun.stdin.stream(), (chunk) => socket.data.writer.write(chunk));

	// The main hung up: what the daemon still sends drains out, and its close ends this process.
	socket.end();
};

export const runRemote = async (command: string | undefined): Promise<void> => {
	switch (command) {
		case 'serve':
			return serve();
		case 'attach':
			return attach();
		default:
			process.stderr.write('usage: voiceos remote serve | voiceos remote attach\n');
			process.exit(2);
	}
};
