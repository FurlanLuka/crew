// Another session's ask, answered by a read-only copy of this one: what it knows first, then what it
// can read in its own folders. It never runs anything, never changes anything, and never reads a
// secret — a secret moves only through request_secret, with the developer's OK.
import type { HookCallback, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../log.js';
import type { PeerForkStatus } from '../shared/protocol.js';
import type { RawMessage } from './events.js';
import { dropCheckpoints, isTopLevelAssistant, readText, runFork } from './fork.js';
import {
	isSecretPath,
	isSecretPattern,
	resolveInsideRoots,
	type SessionRoots,
} from './peer-paths.js';
import type { QueryLaunch } from './worker.js';

const log = createLogger('session-asks');

export const SESSION_ASK_TIMEOUT_MS = 3 * 60_000;
const SESSION_ASK_MAX_TURNS = 8;
const NEEDS_WORK = 'NEEDS_WORK';
const FILES_MARKER = 'FILES:';
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const SECRET_GLOBS = [
	'.env',
	'.env.*',
	'*.pem',
	'*.key',
	'*.p12',
	'*.pfx',
	'*.jks',
	'*.keystore',
	'*.kdbx',
	'id_rsa*',
	'id_dsa*',
	'id_ecdsa*',
	'id_ed25519*',
	'.npmrc',
	'.netrc',
	'.pgpass',
	'.pypirc',
	'.git-credentials',
	'*credential*',
	'*secret*',
	'.ssh',
	'.aws',
	'.gnupg',
	'.docker',
	'.kube',
];
const capitalize = (glob: string): string =>
	glob.replace(/[a-z]/, (letter) => letter.toUpperCase());

// Everything isSecretPath calls a secret, as one ripgrep exclusion (a folder name excludes the
// folder). ripgrep matches case, isSecretPath does not: each name goes in lower, upper and title case.
export const SECRET_EXCLUDING_GLOB = `!{${[
	...new Set(SECRET_GLOBS.flatMap((glob) => [glob, glob.toUpperCase(), capitalize(glob)])),
].join(',')}}`;

export const buildSessionAskPrompt = (fromLabel: string, question: string, cwd: string): string =>
	[
		`Another session, ${fromLabel}, asks you this while you work on something else. It is not a new task and not the developer. The question is about your own work and your own files unless it says otherwise.`,
		`Answer from this conversation first. If you need to look something up, use Read, Grep and Glob on your own folders (your worktree is ${cwd}); Bash and every other tool are refused here, and nothing you do here changes your work.`,
		'Never repeat a secret value (a key, token or password): name the variable or the file instead.',
		`Reply with the answer only, written for another Claude: plain and complete, a few sentences or a short list. If answering would need running something (tests, a command, a server, a database), reply ${NEEDS_WORK}: and one line saying exactly what would have to run. To hand over files, end with a line ${FILES_MARKER} and then one path per line, inside your folders.`,
		'',
		question,
	].join('\n');

export type ForkToolVerdict =
	| { kind: 'allow'; updatedInput?: Record<string, unknown> }
	| { kind: 'deny'; reason: string };

const readString = (input: Record<string, unknown>, key: string): string | null =>
	typeof input[key] === 'string' ? (input[key] as string) : null;

const checkRootedPath = (path: string | null, roots: SessionRoots): ForkToolVerdict | null => {
	if (path === null) {
		return null;
	}

	const inside = resolveInsideRoots(path, roots);

	if (!inside) {
		return { kind: 'deny', reason: `${path} is outside your folders.` };
	}

	return isSecretPath(inside)
		? { kind: 'deny', reason: `${path} is a secret: it is never read here.` }
		: null;
};

// The whole of the copy's safety rule: read inside its own folders, never a secret, nothing else.
export const decideForkTool = (
	toolName: string,
	input: Record<string, unknown>,
	roots: SessionRoots,
): ForkToolVerdict => {
	if (!READ_TOOLS.has(toolName)) {
		return {
			kind: 'deny',
			reason: `Only Read, Grep and Glob run here: use Read for a file, Grep to search, Glob to list. If answering needs more, reply ${NEEDS_WORK}: and what would have to run.`,
		};
	}

	if (toolName === 'Read') {
		const path = readString(input, 'file_path');

		return path === null
			? { kind: 'deny', reason: 'Read needs a file path.' }
			: (checkRootedPath(path, roots) ?? { kind: 'allow' });
	}

	const pathVerdict = checkRootedPath(readString(input, 'path'), roots);

	if (pathVerdict) {
		return pathVerdict;
	}

	const pattern = readString(input, 'pattern') ?? '';

	if (toolName === 'Glob') {
		return isSecretPattern(pattern)
			? { kind: 'deny', reason: 'That pattern lists secret files.' }
			: { kind: 'allow' };
	}

	const glob = readString(input, 'glob');

	if (glob !== null && isSecretPattern(glob)) {
		return { kind: 'deny', reason: 'That search targets secret files.' };
	}

	// A glob of its own could still reach a secret by its name (client_secret.json), and the one
	// glob a search takes is the secret exclusion: narrowing is done with path.
	if (glob !== null) {
		return {
			kind: 'deny',
			reason:
				'Grep here takes no glob: narrow the search with path (secret files are always left out).',
		};
	}

	return { kind: 'allow', updatedInput: { ...input, glob: SECRET_EXCLUDING_GLOB } };
};

export const createForkToolHook =
	(roots: SessionRoots): HookCallback =>
	async (hookInput) => {
		const toolName = 'tool_name' in hookInput ? String(hookInput.tool_name) : '';
		const toolInput =
			'tool_input' in hookInput && hookInput.tool_input && typeof hookInput.tool_input === 'object'
				? (hookInput.tool_input as Record<string, unknown>)
				: {};
		const verdict = decideForkTool(toolName, toolInput, roots);

		if (verdict.kind === 'deny') {
			log.info('fork tool denied', { tool: toolName, reason: verdict.reason });
		}

		return {
			hookSpecificOutput: {
				hookEventName: 'PreToolUse' as const,
				permissionDecision: verdict.kind,
				...(verdict.kind === 'deny' ? { permissionDecisionReason: verdict.reason } : {}),
				...(verdict.kind === 'allow' && verdict.updatedInput
					? { updatedInput: verdict.updatedInput }
					: {}),
			},
		};
	};

export interface SessionAskOutcome {
	status: PeerForkStatus;
	// The answer, what would have to run, or why it failed.
	answer: string;
	// Paths the copy handed over, as it wrote them.
	files: string[];
	// What it read or searched.
	read: string[];
}

interface ToolUseBlock {
	type: 'tool_use';
	name: string;
	input: Record<string, unknown>;
}

const listToolUses = (message: RawMessage): ToolUseBlock[] => {
	const content = message.message?.content;

	return Array.isArray(content)
		? (content as Record<string, unknown>[]).filter(
				(block): block is ToolUseBlock & Record<string, unknown> =>
					block.type === 'tool_use' && typeof block.name === 'string',
			)
		: [];
};

const describeRead = ({ name, input }: ToolUseBlock): string | null => {
	const target = readString(input ?? {}, 'file_path') ?? readString(input ?? {}, 'pattern');

	// A secret it reached for was refused, never read: the card must not say it was.
	return READ_TOOLS.has(name) && target && !isSecretPath(target) ? target : null;
};

const splitFiles = (reply: string): { answer: string; files: string[] } => {
	const at = reply.lastIndexOf(`\n${FILES_MARKER}`);
	const start = reply.startsWith(FILES_MARKER) ? 0 : at;

	if (start < 0) {
		return { answer: reply, files: [] };
	}

	const files = reply
		.slice(start)
		.trim()
		.slice(FILES_MARKER.length)
		.split('\n')
		.map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
		.filter(Boolean);

	return { answer: reply.slice(0, start).trim(), files: [...new Set(files)] };
};

export const classifySessionAsk = (messages: RawMessage[]): SessionAskOutcome => {
	const assistant = messages.filter(isTopLevelAssistant);
	const read = [
		...new Set(assistant.flatMap(listToolUses).flatMap((use) => describeRead(use) ?? [])),
	];
	const result = messages.find((message) => message.type === 'result');

	if (result?.is_error && result.subtype !== 'error_max_turns') {
		return { status: 'failed', answer: result.subtype ?? 'error result', files: [], read };
	}

	const { kept } = dropCheckpoints(assistant.map(readText).filter((text) => text.trim()));
	// Joined: the copy may give its answer and its FILES list in separate messages.
	const reply = kept.join('\n').trim();

	if (!reply) {
		return {
			status: 'failed',
			answer: result?.subtype === 'error_max_turns' ? 'ran out of turns' : 'no answer',
			files: [],
			read,
		};
	}

	const needsWorkAt = reply.indexOf(NEEDS_WORK);

	if (needsWorkAt >= 0) {
		const need = reply
			.slice(needsWorkAt + NEEDS_WORK.length)
			.replace(/^[:\s]+/, '')
			.split('\n')[0]
			?.trim();

		return {
			status: 'needs_work',
			answer: need || 'something it could not run here',
			files: [],
			read,
		};
	}

	const { answer, files } = splitFiles(reply);

	return { status: 'answered', answer: answer || reply, files, read };
};

export interface RunSessionAskForkParams {
	launch: QueryLaunch;
	sessionId: string | null;
	fromLabel: string;
	question: string;
	runQuery?: typeof sdkQuery;
	timeoutMs?: number;
}

export const runSessionAskFork = async ({
	launch,
	sessionId,
	fromLabel,
	question,
	runQuery,
	timeoutMs = SESSION_ASK_TIMEOUT_MS,
}: RunSessionAskForkParams): Promise<SessionAskOutcome> => {
	if (!sessionId) {
		return { status: 'failed', answer: 'it has no conversation yet', files: [], read: [] };
	}

	const startedAt = Date.now();

	log.info('fork started', { cwd: launch.cwd, sessionId, chars: question.length });

	const run = await runFork({
		launch,
		sessionId,
		prompt: buildSessionAskPrompt(fromLabel, question, launch.cwd),
		maxTurns: SESSION_ASK_MAX_TURNS,
		preToolUse: createForkToolHook({ cwd: launch.cwd, dirs: launch.dirs }),
		timeoutMs,
		...(runQuery ? { runQuery } : {}),
	});

	if (run.kind === 'failed' || run.kind === 'timed_out') {
		const answer = run.kind === 'failed' ? run.reason : 'it took too long';

		log.warn('fork failed', { sessionId, reason: answer, ms: Date.now() - startedAt });

		return { status: 'failed', answer, files: [], read: [] };
	}

	const outcome = classifySessionAsk(run.messages);

	log.info('fork settled', {
		sessionId,
		status: outcome.status,
		chars: outcome.answer.length,
		read: outcome.read.length,
		files: outcome.files.length,
		ms: Date.now() - startedAt,
	});

	return outcome;
};
