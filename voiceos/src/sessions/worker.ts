import { query as sdkQuery, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Observation } from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { mapMessage, type MapContext, type RawMessage } from './events.js';
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
	// Workers bill the Claude subscription; an API key in env would switch to per-token billing.
	const env: Record<string, string | undefined> = { ...base, HOME: home, CREW_REF: ref };

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
}

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

	start(): void {
		void this.run(this.options.resumeId);
	}

	send(said: string, note?: string): void {
		// The note is Voice OS context for Claude, read ahead of the developer's words.
		const message = note ? `${note}\n\n${said}` : said;
		const text = this.isBriefingPending ? buildBriefing(message) : message;

		if (this.isBriefingPending) {
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

	stop(): void {
		if (this.isStopped) {
			return;
		}

		this.isStopped = true;
		log.info('stop', { ref: this.options.ref });
		this.input.close();
		this.abort.abort();
	}

	private async run(resumeId: string | null): Promise<void> {
		const { ref, cwd, dirs, orientation, env, permissions, emit } = this.options;
		const mapContext: MapContext = {
			ref,
			toolSummaries: new Map(),
			limits: { fiveHour: null, sevenDay: null, resetsAt: null },
		};
		const runQuery = this.options.runQuery ?? sdkQuery;

		log.info('starting', { ref, cwd, resume: Boolean(resumeId) });

		try {
			this.activeQuery = runQuery({
				prompt: this.input,
				options: {
					cwd,
					additionalDirectories: dirs,
					env,
					abortController: this.abort,
					permissionMode: this.options.permissionMode ?? 'auto',
					canUseTool: permissions.canUseTool(ref, cwd) as never,
					includePartialMessages: true,
					settingSources: ['user', 'project', 'local'],
					systemPrompt: { type: 'preset', preset: 'claude_code', append: orientation },
					...(resumeId ? { resume: resumeId } : {}),
					...(this.options.model ? { model: this.options.model } : {}),
					...(this.options.claudeBin ? { pathToClaudeCodeExecutable: this.options.claudeBin } : {}),
					...(this.options.maxBudgetUsd ? { maxBudgetUsd: this.options.maxBudgetUsd } : {}),
				},
			});

			emit({ type: 'session_started', ref });

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

			if (resumeId && !this.isInitialized) {
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
