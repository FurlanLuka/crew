import { isChatRef } from '../shared/machine-ref.js';
import {
	query as sdkQuery,
	type Query,
	type SDKUserMessage,
	type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type { Observation, SessionCommand } from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { readGuardedCommand } from '../state/commands.js';
import { createMapContext, mapMessage, readDenial, type RawMessage } from './events.js';
import { createMediaHooks } from './media.js';
import type { PermissionBridge } from './permissions.js';
import { buildBriefing } from './voice-context.js';

const log = createLogger('worker');

const STRIPPED_ENV = [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'VOICEOS_ANTHROPIC_API_KEY',
	'SONIOX_API_KEY',
];

export interface BuildWorkerEnvParams {
	base: Record<string, string | undefined>;
	ref: string;
	home: string;
	shouldKeepApiKey: boolean;
}

export const buildWorkerEnv = ({
	base,
	ref,
	home,
	shouldKeepApiKey,
}: BuildWorkerEnvParams): Record<string, string | undefined> => {
	// The SDK offers its Artifact tools to a non-interactive session only with CLAUDE_CODE_ARTIFACT
	// set (the enableArtifact setting alone does not): sessions make docs the developer opens by
	// voice. A developer's own value, 0 included, stands.
	const env: Record<string, string | undefined> = {
		CLAUDE_CODE_ARTIFACT: '1',
		...base,
		HOME: home,
		// A plain session is not a worktree: crew commands there must not think they are in one.
		...(isChatRef(ref) ? {} : { CREW_REF: ref }),
	};

	// Workers bill the Claude subscription; an API key in env would switch to per-token billing.
	for (const key of STRIPPED_ENV) {
		// Only tests opt back in to the API key.
		if (shouldKeepApiKey && key === 'ANTHROPIC_API_KEY') {
			continue;
		}

		// Removed, not set to undefined: a child given the key at all could pick it up.
		delete env[key];
	}

	return env;
};

class InputChannel implements AsyncIterable<SDKUserMessage> {
	private buffer: SDKUserMessage[] = [];
	private waiting: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
	private isClosed = false;

	push(text: string): void {
		const message: SDKUserMessage = {
			type: 'user',
			message: { role: 'user', content: text },
			parent_tool_use_id: null,
		};

		if (this.waiting) {
			const resolve = this.waiting;

			this.waiting = null;
			resolve({ value: message, done: false });

			return;
		}

		this.buffer.push(message);
	}

	close(): void {
		this.isClosed = true;
		this.waiting?.({ value: undefined, done: true });
		this.waiting = null;
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: () => {
				const next = this.buffer.shift();

				if (next) {
					return Promise.resolve({ value: next, done: false });
				}

				if (this.isClosed) {
					return Promise.resolve({ value: undefined, done: true });
				}

				return new Promise((resolve) => {
					this.waiting = resolve;
				});
			},
		};
	}
}

export interface QueryLaunch {
	cwd: string;
	dirs: string[];
	env: Record<string, string | undefined>;
	orientation: string;
	model?: string;
	claudeBin?: string;
}

export const buildQueryOptions = ({
	cwd,
	dirs,
	env,
	orientation,
	model,
	claudeBin,
}: QueryLaunch) => {
	// Shared by the session and its side-answer fork: the same prefix is what lets the fork hit the prompt cache.
	return {
		cwd,
		additionalDirectories: dirs,
		env,
		settingSources: ['user', 'project', 'local'] as ('user' | 'project' | 'local')[],
		systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: orientation },
		...(model ? { model } : {}),
		...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
	};
};

interface WorkerBriefing {
	// A resumed session from before the current context gets it once, in front of its next message.
	pending: boolean;
	// Runs when that turn has ended, so a turn that never ran is not counted.
	onBriefed: () => void;
}

type InitMessage = RawMessage & { session_id?: string };

export interface WorkerOptions {
	ref: string;
	cwd: string;
	dirs: string[];
	orientation: string;
	resumeId: string | null;
	env: Record<string, string | undefined>;
	permissions: PermissionBridge;
	emit: (observation: Observation) => void;
	onSessionId: (sessionId: string) => void;
	briefing?: WorkerBriefing;
	onResumeFailed: () => void;
	runQuery?: typeof sdkQuery;
	model?: string;
	maxBudgetUsd?: number;
	permissionMode?: 'auto' | 'default';
	claudeBin?: string;
	// Where tool screenshots are kept for the page; unset shows no images.
	mediaDir?: string;
	// The setup session (isPinned) shows no images from its folder (the home folder).
	isPinned: boolean;
}

// Claude's own words when a resumed session id is not in its store (the CLI's stderr, carried in the
// SDK's exit error).
export const isMissingConversation = (message: string): boolean =>
	message.includes('No conversation found');

// A long plugin list stays a menu, not a state blob every tab replays.
const MAX_COMMANDS = 300;

// Rows can share a name: /name runs Claude Code's own when one has it, else the first. The menu
// shows that one alone.
const keepRunnable = (commands: SlashCommand[]): SlashCommand[] =>
	commands.filter((command, index) => {
		const twin = commands.findIndex((other) => other.name === command.name);
		const builtin = commands.findIndex((other) => other.name === command.name && other.builtin);

		return builtin >= 0 ? index === builtin : index === twin;
	});

const toSessionCommand = ({ name, description, argumentHint }: SlashCommand): SessionCommand => ({
	name,
	description: description.slice(0, 200),
	argumentHint: argumentHint.slice(0, 80),
});

const countOf = (count: number, singular: string): string =>
	`${count} ${count === 1 ? singular : `${singular}s`}`;

export class Worker {
	private input = new InputChannel();
	private activeQuery: Query | null = null;
	private abort = new AbortController();
	private sessionId: string | null = null;
	private isStopped = false;
	private isInitialized = false;
	private sentBeforeInit: string[] = [];
	private isBriefingPending: boolean;
	private isAwaitingBriefedTurn = false;

	constructor(private options: WorkerOptions) {
		this.isBriefingPending = options.briefing?.pending ?? false;
	}

	get id(): string | null {
		return this.sessionId;
	}

	get launch(): QueryLaunch {
		const { cwd, dirs, env, orientation, model, claudeBin } = this.options;

		return { cwd, dirs, env, orientation, model, claudeBin };
	}

	start(): void {
		void this.run(this.options.resumeId);
	}

	send(said: string, note?: string): void {
		// A /clear or /compact must reach the CLI as typed, or it is read as prose; the briefing waits.
		const isCommand = readGuardedCommand(said) !== null;
		// The note is Voice OS context for Claude, read ahead of the developer's words.
		const message = note && !isCommand ? `${note}\n\n${said}` : said;
		const shouldBrief = this.isBriefingPending && !isCommand;
		const text = shouldBrief ? buildBriefing(message) : message;

		if (shouldBrief) {
			this.isBriefingPending = false;
			this.isAwaitingBriefedTurn = true;
			log.info('briefing on the current Voice OS context', { ref: this.options.ref });
		}

		log.info('send', { ref: this.options.ref, chars: text.length });

		// Kept without the briefing: a replay after a failed resume goes to a fresh, briefed session.
		if (!this.isInitialized) {
			this.sentBeforeInit.push(message);
		}

		this.input.push(text);
		this.options.emit({ type: 'turn_started', ref: this.options.ref });
	}

	async interrupt(reason?: 'follow-up'): Promise<void> {
		log.info(reason === 'follow-up' ? 'follow-up interrupts the reply' : 'interrupt', {
			ref: this.options.ref,
		});

		const receipt = await this.activeQuery
			?.interrupt()
			.catch((error: unknown) =>
				log.warn('interrupt failed', { ref: this.options.ref, error: String(error) }),
			);
		// Messages the CLI still held: this interrupt aborted nothing of theirs.
		const stillQueued = receipt && 'still_queued' in receipt ? receipt.still_queued : undefined;

		if (stillQueued?.length) {
			log.warn('interrupt left messages queued in the CLI', {
				ref: this.options.ref,
				count: stillQueued.length,
			});
		}
	}

	async setMode(mode: 'default' | 'auto'): Promise<void> {
		log.info('permission mode', { ref: this.options.ref, mode });

		await this.activeQuery
			?.setPermissionMode(mode)
			.catch((error: unknown) =>
				log.warn('set mode failed', { ref: this.options.ref, error: String(error) }),
			);
	}

	// The box's /reload-plugins and /reload-skills. Plugins are held, unless forced, when applying
	// would change the tool list the conversation's cached context depends on.
	async reload(kind: 'plugins' | 'skills', force: boolean): Promise<void> {
		const { ref, emit } = this.options;
		const query = this.activeQuery;

		if (!query) {
			return;
		}

		log.info('reload', { ref, kind, force });

		try {
			if (kind === 'skills') {
				const { skills } = await query.reloadSkills();

				emit({
					type: 'session_notice',
					ref,
					text: `Skills reloaded: ${countOf(skills.length, 'skill')}.`,
				});
				await this.listCommands();

				return;
			}

			const reloaded = await query.reloadPlugins(force ? {} : { holdOnCacheImpact: true });

			if (reloaded.held) {
				emit({
					type: 'session_notice',
					ref,
					text: "Plugins not reloaded: it would change the session's tools and drop its cached context. Send /reload-plugins force to reload anyway.",
				});

				return;
			}

			this.emitCommands(reloaded.commands);
			emit({
				type: 'session_notice',
				ref,
				text: `Plugins reloaded: ${countOf(reloaded.plugins.length, 'plugin')}, ${countOf(reloaded.commands.length, 'command')}, ${countOf(reloaded.agents.length, 'agent')}${reloaded.error_count > 0 ? `, ${countOf(reloaded.error_count, 'error')}` : ''}.`,
			});
		} catch (error) {
			log.warn('reload failed', { ref, kind, error: String(error) });
			emit({ type: 'session_notice', ref, text: `Could not reload ${kind}: ${String(error)}` });
		}
	}

	// The box's /model: the next turn runs on it.
	async setModel(model: string): Promise<void> {
		const { ref, emit } = this.options;

		log.info('model', { ref, model });

		const query = this.activeQuery;

		if (!query) {
			return;
		}

		try {
			await query.setModel(model);
			emit({ type: 'session_notice', ref, text: `Model: ${model}.` });
		} catch (error) {
			log.warn('set model failed', { ref, model, error: String(error) });
			emit({ type: 'session_notice', ref, text: `Could not switch to ${model}: ${String(error)}` });
		}
	}

	private async listCommands(): Promise<void> {
		try {
			this.emitCommands((await this.activeQuery?.supportedCommands()) ?? []);
		} catch (error) {
			log.warn('commands not listed', { ref: this.options.ref, error: String(error) });
		}
	}

	private emitCommands(commands: SlashCommand[]): void {
		this.options.emit({
			type: 'commands_listed',
			ref: this.options.ref,
			commands: keepRunnable(commands).slice(0, MAX_COMMANDS).map(toSessionCommand),
		});
	}

	stop(): void {
		if (this.isStopped) {
			return;
		}

		this.isStopped = true;
		log.info('stop', { ref: this.options.ref });
		this.input.close();
		this.abort.abort();
	}

	private followConversation(raw: InitMessage): void {
		// /clear starts a new conversation in the same process. Its id is not new_conversation_id:
		// the CLI's next init names the transcript that resumes, so that is the one followed.
		if (raw.type !== 'system' || raw.subtype !== 'init' || !raw.session_id) {
			return;
		}

		if (raw.session_id !== this.sessionId) {
			log.info('conversation changed', {
				ref: this.options.ref,
				from: this.sessionId,
				to: raw.session_id,
			});
			this.sessionId = raw.session_id;
			this.options.onSessionId(raw.session_id);
		}
	}

	private async run(resumeId: string | null): Promise<void> {
		const { ref, cwd, dirs, isPinned, mediaDir, permissions, emit } = this.options;
		const mapContext = createMapContext(
			ref,
			mediaDir
				? createMediaHooks({
						session: { cwd, dirs, isPinned },
						mediaDir,
						log: (message, fields) => log.info(message, { ref, ...fields }),
					})
				: undefined,
		);
		const runQuery = this.options.runQuery ?? sdkQuery;

		log.info('starting', { ref, cwd, resume: Boolean(resumeId) });

		try {
			this.activeQuery = runQuery({
				prompt: this.input,
				options: {
					...buildQueryOptions(this.launch),
					abortController: this.abort,
					permissionMode: this.options.permissionMode ?? 'auto',
					canUseTool: permissions.canUseTool(ref, cwd) as never,
					includePartialMessages: true,
					// A sub-agent's own text and results: its transcript on the page.
					forwardSubagentText: true,
					...(resumeId ? { resume: resumeId } : {}),
					...(this.options.maxBudgetUsd ? { maxBudgetUsd: this.options.maxBudgetUsd } : {}),
				},
			});

			emit({ type: 'session_started', ref });
			// Asked of the CLI at once: its init message comes only with the first words, and the menu
			// is wanted before them.
			void this.listCommands();

			for await (const message of this.activeQuery) {
				const raw = message as unknown as InitMessage;

				if (
					!this.isInitialized &&
					raw.type === 'system' &&
					raw.subtype === 'init' &&
					raw.session_id
				) {
					this.isInitialized = true;
					this.sentBeforeInit = [];
					this.sessionId = raw.session_id;
					this.options.onSessionId(raw.session_id);
					log.info('session id', { ref, sessionId: raw.session_id });
				}

				// Skills found as it works, or a plugin added: the "/" menu follows.
				if (message.type === 'system' && message.subtype === 'commands_changed') {
					this.emitCommands(message.commands);
				}

				this.followConversation(raw);

				if (raw.type === 'system' && raw.subtype === 'permission_denied') {
					// Why auto mode refused, never the command or the rejection text.
					const { toolName, isTransient, reasonType, reasonCode } = readDenial(
						raw,
						mapContext.toolSummaries,
					);
					log.info('permission denied', { ref, toolName, isTransient, reasonType, reasonCode });
				}

				for (const observation of mapMessage(raw, mapContext, cwd)) {
					if (observation.type === 'turn_ended' && this.isAwaitingBriefedTurn) {
						this.isAwaitingBriefedTurn = false;
						this.options.briefing?.onBriefed();
					}

					emit(observation);
				}
			}

			log.info('exited', { ref });

			emit({ type: 'worker_exited', ref, error: null });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			if (this.isStopped) {
				emit({ type: 'worker_exited', ref, error: null });

				return;
			}

			// Only Claude saying the conversation is gone starts a fresh one. A kill or crash while it
			// reopens (a restart, memory pressure) keeps the id, so the next start resumes the same
			// conversation and its history.
			if (resumeId && !this.isInitialized && isMissingConversation(message)) {
				log.warn('resume failed, starting a fresh session', { ref, error: message });
				this.options.onResumeFailed();

				// The fresh session's prompt carries the context; no briefing on top.
				this.isBriefingPending = false;
				this.isAwaitingBriefedTurn = false;
				this.input = new InputChannel();
				this.abort = new AbortController();

				// Messages written to the dead session never reached Claude; replay them.
				for (const text of this.sentBeforeInit) {
					this.input.push(text);
				}

				return this.run(null);
			}

			log.error('worker crashed', { ref, error: message });

			emit({ type: 'worker_exited', ref, error: message });
		} finally {
			permissions.settleRef(ref, 'The session ended.');
		}
	}
}
