// The real page behind the real gateway, with a store the caller drives and the fake crew behind
// /api/crew: what the UI tests and the docs screenshots open. Nothing touches ~/.crew.
import index from '../../src/web/index.html';
import { listAllowedOrigins } from '../../src/gateway/auth.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachFileTo } from '../../src/gateway/attach.js';
import { startGateway, type Gateway } from '../../src/gateway/server.js';
import { storeAttachment } from '../../src/sessions/attachments.js';
import type { ClientMessage, WorktreeInfo } from '../../src/shared/protocol.js';
import { Store } from '../../src/state/store.js';
import { createFakeCrew, type FakeCrew, type FakeCrewOptions } from '../support/fake-crew.js';

export const PAGE_TOKEN = 'b'.repeat(64);

export const createWorktree = (ref: string, isPinned = false): WorktreeInfo => ({
	ref,
	label: ref,
	branch: isPinned ? '' : `crew/${ref}`,
	cwd: isPinned ? '/Users/dev' : `/w/${ref}`,
	dirs: [],
	isPinned,
});

export interface PageServer {
	gateway: Gateway;
	store: Store;
	crew: FakeCrew;
	received: { message: ClientMessage; client: string }[];
	effects: string[];
	// How long the cockpit's crew ls worktrees read takes: live it is a process, slower than the
	// page's next message, so a test that depends on that order sets it.
	latency: { worktreesMs: number };
	url: (path?: string) => string;
	loginUrl: (path?: string) => string;
	stop: () => void;
}

interface StartPageServerOptions extends FakeCrewOptions {
	store?: Store;
	port?: number;
}

export const startPageServer = ({
	store = new Store(),
	port = 0,
	...crewOptions
}: StartPageServerOptions = {}): PageServer => {
	const crew = createFakeCrew(crewOptions);
	const received: PageServer['received'] = [];
	const effects: string[] = [];
	const latency = { worktreesMs: 0 };
	const filesRoot = mkdtempSync(join(tmpdir(), 'voiceos-page-files-'));

	// Stands in for the cockpit's crew ls worktrees read: what the store lists, plus the worktrees
	// the fake crew has made since.
	const refreshWorktrees = async (): Promise<void> => {
		if (latency.worktreesMs > 0) {
			await Bun.sleep(latency.worktreesMs);
		}

		const reply = await crew.runCrew('local', { type: 'ls_worktrees' });
		const rows: { ref?: unknown }[] =
			reply.kind === 'ran' ? (JSON.parse(reply.result.stdout || '[]') as { ref?: unknown }[]) : [];
		const { sessions, order } = store.state;
		const listed = order.flatMap((ref) => {
			const session = sessions[ref];

			return session
				? [
						{
							ref,
							label: session.label,
							branch: session.branch,
							cwd: session.cwd,
							dirs: session.dirs,
							isPinned: session.isPinned,
						},
					]
				: [];
		});
		const made = rows
			.map((row) => String(row.ref ?? ''))
			.filter((ref) => ref && !ref.startsWith('check/') && !sessions[ref])
			.map((ref) => createWorktree(ref));

		store.dispatch({ type: 'worktrees', worktrees: [...listed, ...made] });
	};

	store.onEffect((effect) => {
		effects.push(effect.type);

		if (effect.type === 'refresh_worktrees') {
			queueMicrotask(() => void refreshWorktrees());
		}

		// Stand in for a worker so an activated session reaches idle.
		if (effect.type === 'worker_start') {
			queueMicrotask(() => store.dispatch({ type: 'session_started', ref: effect.ref }));
		}
	});

	const gateway = startGateway({
		store,
		token: PAGE_TOKEN,
		port,
		index,
		listAllowedOrigins: (serverPort) =>
			listAllowedOrigins({ port: serverPort, proxyHost: null, proxyPort: null }),
		onMessage: (message, client) => {
			received.push({ message, client });

			if (message.type === 'action') {
				store.dispatch(message.action);
			}
		},
		onAudio: () => undefined,
		readHealth: () => ({}),
		runCrew: crew.runCrew,
		attachFile: attachFileTo({
			readState: () => store.state,
			dispatch: (observation) => store.dispatch(observation),
			store: (file) =>
				storeAttachment({
					...file,
					dir: join(filesRoot, 'attachments'),
					mediaDir: join(filesRoot, 'media'),
				}),
		}),
		// No hot reload: its socket would push every file another process saves into pages the test already closed.
		development: false,
	});
	const base = `http://localhost:${gateway.port}`;

	return {
		gateway,
		store,
		crew,
		received,
		effects,
		latency,
		url: (path = '/') => `${base}${path}`,
		// The login redirects to /; the page then goes where it is sent.
		loginUrl: () => `${base}/login?token=${PAGE_TOKEN}`,
		stop: () => {
			gateway.stop();
			rmSync(filesRoot, { recursive: true, force: true });
		},
	};
};
