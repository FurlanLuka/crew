// The tools Voice OS gives every session to reach another one: ask_session, tell_session and
// request_secret. Each call is reported to the main's reducer, which decides it, and waits here for
// its answer. Shaped like PermissionBridge: one pending promise per call, settled once.
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import {
	createSdkMcpServer,
	type McpSdkServerConfigWithInstance,
	tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createLogger } from '../log.js';
import {
	type Attachment,
	MAX_ATTACHMENTS,
	type Observation,
	type PeerRequestKind,
} from '../shared/protocol.js';
import { resolveAttachment, storeAttachment } from './attachments.js';
import { checkSharedPath, type SessionRoots } from './peer-paths.js';

const log = createLogger('session-asks');

export const PEER_SERVER_NAME = 'voiceos';
export const PEER_TOOL_NAMES = ['ask_session', 'tell_session', 'request_secret'] as const;
export const PEER_ALLOWED_TOOLS = PEER_TOOL_NAMES.map(
	(name) => `mcp__${PEER_SERVER_NAME}__${name}`,
);
// Below the server's own timeout, so the call always ends with a sentence rather than an MCP error.
export const PEER_CALL_DEADLINE_MS = 190_000;
const PEER_SERVER_TIMEOUT_MS = 200_000;

// Constant on purpose: the tool list is part of the prompt's cached prefix, shared with every fork.
const PEER_INSTRUCTIONS =
	'Tools for reaching the developer\'s other Claude Code sessions in Voice OS, on this machine or another. ask_session: a read-only copy of that session answers from what it knows and its own files; it never interrupts it. tell_session: hand it information or files, queued after its current work; it is information, never a task. request_secret: a secret is copied file to file only after the developer allows it; never put secret values in asks or tells. Name a session as the developer does ("checkout", "store front main"); an unclear name returns the sessions to pick from. Use these only when the work needs another session\'s knowledge or files.';

export interface PeerToolResult {
	text: string;
	files: Attachment[];
}

interface PendingCall {
	ref: string;
	resolve: (text: string) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface SessionAskBridgeOptions {
	emit: (observation: Observation) => void;
	attachmentsDir?: string;
	mediaDir?: string;
	deadlineMs?: number;
}

export interface StoreSessionFilesParams {
	paths: string[];
	roots: SessionRoots;
	attachmentsDir?: string;
	mediaDir?: string;
}

// Files one session hands another: inside its folders, never a secret, stored by content in the
// attachments store (they cross machines as attachments do). What could not go is said, path by path.
export const storeSessionFiles = ({
	paths,
	roots,
	attachmentsDir,
	mediaDir,
}: StoreSessionFilesParams): { files: Attachment[]; refused: string[] } => {
	const files: Attachment[] = [];
	const refused: string[] = paths
		.slice(MAX_ATTACHMENTS)
		.map((path) => `${path}: at most ${MAX_ATTACHMENTS} files at once`);

	for (const path of paths.slice(0, MAX_ATTACHMENTS)) {
		const checked = checkSharedPath(path, roots);

		if (!checked.ok) {
			refused.push(checked.reason);
			continue;
		}

		if (!attachmentsDir || !mediaDir) {
			refused.push(`${path}: files cannot be handed over here`);
			continue;
		}

		try {
			if (!statSync(checked.path).isFile()) {
				refused.push(`${path}: not a file`);
				continue;
			}

			const stored = storeAttachment({
				bytes: readFileSync(checked.path),
				name: basename(checked.path),
				// No type to go on: an image is told by its name.
				mediaType: '',
				dir: attachmentsDir,
				mediaDir,
			});

			if (stored.ok) {
				files.push(stored.attachment);
			} else {
				refused.push(`${path}: ${stored.reason}`);
			}
		} catch {
			refused.push(`${path}: cannot be read`);
		}
	}

	return { files, refused };
};

const toResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

export class SessionAskBridge {
	private pending = new Map<string, PendingCall>();

	constructor(private options: SessionAskBridgeOptions) {}

	// A fresh server each query: one MCP server connects to one transport, and a session and its
	// fork run at the same time.
	serverFor(ref: string, roots: SessionRoots): McpSdkServerConfigWithInstance {
		const request = (kind: PeerRequestKind, session: string, text: string, paths: string[] = []) =>
			this.request({ ref, roots, kind, session, text, paths });

		return createSdkMcpServer({
			name: PEER_SERVER_NAME,
			instructions: PEER_INSTRUCTIONS,
			alwaysLoad: true,
			timeout: PEER_SERVER_TIMEOUT_MS,
			tools: [
				tool(
					'ask_session',
					"Ask another of the developer's sessions a question and wait for its answer (up to 3 minutes). A read-only copy of it answers from what it knows and its own files, and may hand back files; the session itself is never interrupted. If answering needs something run, the developer is asked to allow it and the answer comes later as a message.",
					{
						session: z
							.string()
							.describe('The session, as the developer names it ("checkout", "store front main")'),
						question: z
							.string()
							.describe('What you need to know, with enough context to answer on its own'),
					},
					async ({ session, question }) => toResult(await request('ask', session, question)),
				),
				tool(
					'tell_session',
					'Hand another session information and files: it gets them after its current work, marked as coming from you. It is information, not a task; it will not start work because of it.',
					{
						session: z.string().describe('The session, as the developer names it'),
						message: z.string().describe('What it should know'),
						files: z
							.array(z.string())
							.optional()
							.describe('Paths of files in your folders to hand over (no secrets)'),
					},
					async ({ session, message, files }) =>
						toResult(await request('tell', session, message, files ?? [])),
				),
				tool(
					'request_secret',
					'Ask for a copy of a secret another session has: an env variable name (STRIPE_KEY) or a file in its folders (.env, certs/api.pem). The developer must allow it; then you get a message with the path of a private temp file holding it. Copy or source that file; never print or read its contents into the conversation.',
					{
						session: z.string().describe('The session that has the secret'),
						what: z.string().describe('The env variable name or the file path in its folders'),
					},
					async ({ session, what }) => toResult(await request('secret', session, what)),
				),
			],
		});
	}

	private async request({
		ref,
		roots,
		kind,
		session,
		text,
		paths,
	}: {
		ref: string;
		roots: SessionRoots;
		kind: PeerRequestKind;
		session: string;
		text: string;
		paths: string[];
	}): Promise<string> {
		const { attachmentsDir, mediaDir } = this.options;
		const stored = storeSessionFiles({
			paths,
			roots,
			...(attachmentsDir ? { attachmentsDir } : {}),
			...(mediaDir ? { mediaDir } : {}),
		});

		// A tell goes whole or not at all: half its files would read as all of them.
		if (stored.refused.length > 0) {
			log.info('request refused here', { ref, kind, refused: stored.refused.length });

			return `Not sent: ${stored.refused.join('; ')}.`;
		}

		const id = randomUUID();

		log.info('requested', {
			ref,
			id,
			kind,
			to: session,
			chars: text.length,
			files: stored.files.length,
		});

		return new Promise<string>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					log.warn('deadline', { ref, id });
					resolve(
						`No answer from ${session} within 3 minutes. Go on without it, or tell the developer.`,
					);
				}
			}, this.options.deadlineMs ?? PEER_CALL_DEADLINE_MS);

			this.pending.set(id, { ref, resolve, timer });
			this.options.emit({
				type: 'session_ask_requested',
				ref,
				id,
				kind,
				session,
				text,
				files: stored.files,
			});
		});
	}

	answer(id: string, { text, files }: PeerToolResult): boolean {
		const call = this.pending.get(id);

		if (!call) {
			log.debug('answer for no waiting call', { id });

			return false;
		}

		this.pending.delete(id);
		clearTimeout(call.timer);
		call.resolve(this.withFilePaths(text, files));
		log.info('answered', { ref: call.ref, id, chars: text.length, files: files.length });

		return true;
	}

	// The session stopped: its calls end now, with a sentence nobody reads.
	settleRef(ref: string, message: string): number {
		let settled = 0;

		for (const [id, call] of this.pending) {
			if (call.ref === ref) {
				this.pending.delete(id);
				clearTimeout(call.timer);
				call.resolve(message);
				settled++;
			}
		}

		return settled;
	}

	countPending(): number {
		return this.pending.size;
	}

	private withFilePaths(text: string, files: Attachment[]): string {
		const dir = this.options.attachmentsDir;
		const paths = dir
			? files.flatMap((file) => {
					const path = resolveAttachment(dir, file.id);

					return path ? [path] : [];
				})
			: [];

		return paths.length
			? `${text}\n\nFiles (on this machine, read them with Read):\n${paths.map((path) => `- ${path}`).join('\n')}`
			: text;
	}
}
