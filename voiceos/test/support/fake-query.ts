// Stands in for the Agent SDK's query(): the session manager's tests, and the link tests that run a
// real remote host over an in-memory link.

export interface FakeQueryParams {
	failResume?: boolean;
	// Why a resume fails: by default Claude's own "No conversation found"; a kill says something else.
	resumeError?: string;
	holdTurns?: boolean;
	// What a side-answer fork replies; an Error makes the fork throw.
	sideReply?: unknown[] | Error;
	// A message containing these words asks permission mid-turn (a Bash call) and waits for the answer.
	askOn?: string;
	// The session's slash commands, as Claude Code lists them.
	commands?: { name: string; description: string; argumentHint: string }[];
	// A plugin reload asked to hold on cache impact is held.
	holdReload?: boolean;
	// What the session lists after a reload (else the same commands).
	reloadedCommands?: { name: string; description: string; argumentHint: string }[];
	// Reload and model calls fail with this.
	controlError?: Error;
	// As the real CLI: its init message comes only with the first words.
	isInitLate?: boolean;
}

interface FakeQueryCall {
	prompt: AsyncIterable<{ message: { content: string } }>;
	options: {
		abortController: AbortController;
		cwd: string;
		resume?: string;
		forkSession?: boolean;
		permissionMode?: string;
		systemPrompt: { append: string };
		canUseTool?: (
			toolName: string,
			input: Record<string, unknown>,
			options: { signal: AbortSignal; suggestions: unknown[] },
		) => Promise<{ behavior: string }>;
	};
}

export const createFakeQuery = ({
	failResume = false,
	resumeError = 'No conversation found with session ID',
	holdTurns = false,
	sideReply = [],
	askOn,
	commands = [],
	holdReload = false,
	reloadedCommands,
	controlError,
	isInitLate = false,
}: FakeQueryParams = {}) => {
	const reloads: string[] = [];
	let pushCommands: (next: unknown[]) => void = () => undefined;
	const models: string[] = [];
	// The mode each query opened in, then every switch, in order.
	const modes: string[] = [];
	// Stands in for the Agent SDK; holdTurns: a turn only ends when interrupted, like a cut reply.
	const started: string[] = [];
	const prompts: string[] = [];
	const sent: string[] = [];
	// Counts interrupts across the fake's lifetime.
	let interrupts = 0;
	const forks: FakeQueryCall['options'][] = [];
	// A fork is asked with one prompt string: the side question.
	const forkPrompts: unknown[] = [];
	// How each mid-turn ask was answered, in order.
	const decisions: string[] = [];

	const runQuery = ((call: FakeQueryCall) => {
		if (call.options.forkSession) {
			forks.push(call.options);
			forkPrompts.push(call.prompt);

			return {
				async *[Symbol.asyncIterator]() {
					if (sideReply instanceof Error) {
						throw sideReply;
					}

					yield* sideReply;
				},
			};
		}

		if (failResume && call.options.resume) {
			return {
				[Symbol.asyncIterator]: () => ({
					next: () => Promise.reject(new Error(resumeError)),
				}),
				interrupt: async () => undefined,
				setPermissionMode: async () => undefined,
			};
		}

		started.push(call.options.cwd);
		modes.push(`open ${call.options.permissionMode ?? 'none'}`);
		let listed = commands;
		prompts.push(call.options.systemPrompt.append);

		const { signal } = call.options.abortController;
		const init = { type: 'system', subtype: 'init', session_id: `s-${started.length}` };
		const queued: unknown[] = isInitLate ? [] : [init];
		let isInitSent = !isInitLate;

		// Replaced by each wait so a new message or interrupt wakes the stream.
		let wake: () => void = () => {
			// Nothing is waiting yet.
		};

		void (async () => {
			for await (const message of call.prompt) {
				sent.push(message.message.content);

				if (!isInitSent) {
					isInitSent = true;
					queued.push(init);
				}

				if (askOn && message.message.content.includes(askOn) && call.options.canUseTool) {
					const answer = await call.options.canUseTool(
						'Bash',
						{ command: 'git push' },
						{ signal, suggestions: [] },
					);

					decisions.push(answer.behavior);
				}

				if (!holdTurns) {
					queued.push({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 });
				}

				wake();
			}
		})();

		// Claude Code's mid-session command list, pushed into the newest session.
		pushCommands = (next) => {
			queued.push({ type: 'system', subtype: 'commands_changed', commands: next });
			wake();
		};

		const interrupt = async () => {
			interrupts++;
			queued.push({ type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 });
			wake();

			return { still_queued: [] };
		};

		return {
			async *[Symbol.asyncIterator]() {
				while (!signal.aborted) {
					while (queued.length) {
						yield queued.shift();
					}

					await new Promise<void>((resolve) => {
						wake = resolve;
						signal.addEventListener('abort', () => resolve(), { once: true });
					});
				}
			},
			interrupt,
			setPermissionMode: async (mode: string) => {
				modes.push(`set ${mode}`);
			},
			// As full as the turns so far: 1000 tokens each, against a 200k window.
			getContextUsage: async () => ({ totalTokens: 1000 * sent.length, rawMaxTokens: 200_000 }),
			supportedCommands: async () => listed,
			reloadSkills: async () => {
				reloads.push('skills');

				if (controlError) {
					throw controlError;
				}

				listed = reloadedCommands ?? listed;

				return { skills: listed.slice(0, 1) };
			},
			reloadPlugins: async (options?: { holdOnCacheImpact?: boolean }) => {
				reloads.push(options?.holdOnCacheImpact ? 'plugins:hold' : 'plugins');

				if (controlError) {
					throw controlError;
				}

				const isHeld = Boolean(options?.holdOnCacheImpact && holdReload);

				listed = isHeld ? listed : (reloadedCommands ?? listed);

				return {
					commands: listed,
					agents: [],
					plugins: [{ name: 'p', path: '/p' }],
					mcpServers: [],
					error_count: 0,
					...(isHeld ? { held: true } : {}),
				};
			},
			setModel: async (model?: string) => {
				models.push(model ?? '');

				if (controlError) {
					throw controlError;
				}
			},
		};
	}) as never;

	return {
		runQuery,
		reloads,
		models,
		modes,
		pushCommands: (next: unknown[]) => pushCommands(next),
		started,
		prompts,
		sent,
		forks,
		forkPrompts,
		decisions,
		interrupts: () => interrupts,
	};
};
