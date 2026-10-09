import type { Effect } from '../state/reducer.js';
import type { Observation, SdkMode, Session, State } from '../shared/protocol.js';
import { runSessionAskFork } from './session-ask-fork.js';
import { readSecret, removeSessionSecrets, type SecretCopy } from './secrets.js';
import { SessionAskBridge, storeSessionFiles } from './session-ask-tools.js';
import { createLogger } from '../log.js';
import { PermissionBridge } from './permissions.js';
import { forgetSession, loadRegistry, markBriefed, recordSession } from './registry.js';
import { isChangingWork, runSideAnswer } from './side-answer.js';
import { Worker, buildWorkerEnv, type WorkerOptions } from './worker.js';
import { BRIEFING_VERSION, appendVoiceContext } from './voice-context.js';
import { describeAttached, resolveAttachment, writeChunk } from './attachments.js';

const log = createLogger('sessions');

// What the manager needs to know of a session to start it: the cockpit reads its store, a remote
// host its own worktree list.
export type SessionFacts = Pick<Session, 'cwd' | 'dirs' | 'isPinned' | 'status'>;

interface StoreLike {
	readonly state: State;
	dispatch: (input: Observation) => State;
}

// The cockpit's wiring: sessions read from and report to its store.
export const connectStore = (
	store: StoreLike,
): Pick<SessionManagerOptions, 'readSession' | 'emit'> => ({
	readSession: (ref) => store.state.sessions[ref],
	emit: (observation) => {
		const next = store.dispatch(observation);

		// Said already in the session's own line: Voice OS did not ask it again (see asks.ts).
		if (
			observation.type === 'ask_opened' &&
			next.sessions[observation.ask.ref]?.askedByLine === observation.ask.id
		) {
			log.info('ask not read: the session asked it', {
				ref: observation.ask.ref,
				kind: observation.ask.kind,
			});
		}
	},
});

export interface SessionManagerOptions {
	readSession: (ref: string) => SessionFacts | undefined;
	emit: (observation: Observation) => void;
	registryFile: string;
	home: string;
	fetchOrientation: (ref: string) => Promise<string>;
	shouldKeepApiKey?: boolean;
	model?: string;
	maxBudgetUsd?: number;
	claudeBin?: string;
	runQuery?: WorkerOptions['runQuery'];
	mediaDir?: string;
	// Files the developer attached, by id (sessions/attachments.ts); the paths go to Claude.
	attachmentsDir?: string;
	// Where secret copies for this machine's sessions are kept: a session's go when it stops.
	secretsDir?: string;
	// A secret the developer allowed, read here: its bytes go to the asker's machine beside the state.
	onSecret?: (copy: SecretCopy) => void;
}

export class SessionManager {
	// Owns processes, never state: every change it observes goes back through emit.
	private workers = new Map<string, Worker>();
	private pendingStarts = new Map<string, number>();
	// Each session's mode, from the main: what its worker starts in.
	private modes = new Map<string, SdkMode>();
	private generation = 0;
	readonly permissions: PermissionBridge;
	readonly peers: SessionAskBridge;

	constructor(private options: SessionManagerOptions) {
		const { emit } = options;

		this.permissions = new PermissionBridge(
			(ask) => emit({ type: 'ask_opened', ask }),
			(askId) => emit({ type: 'ask_closed', askId }),
		);
		this.peers = new SessionAskBridge({
			emit,
			...(options.attachmentsDir ? { attachmentsDir: options.attachmentsDir } : {}),
			...(options.mediaDir ? { mediaDir: options.mediaDir } : {}),
		});
	}

	handle = (effect: Effect): void | Promise<void> => {
		switch (effect.type) {
			case 'worker_start':
				this.modes.set(effect.ref, effect.mode);

				return this.start(effect.ref);
			case 'worker_send':
				return this.workers.get(effect.ref)?.send(effect.text, this.noteFor(effect));
			case 'attachment_chunk':
				return this.receiveChunk(effect);
			case 'worker_stop':
				return this.stop(effect.ref);
			case 'worker_interrupt':
				return this.workers.get(effect.ref)?.interrupt(effect.reason);
			case 'worker_set_mode':
				// Kept even before the worker exists: a start still waiting on its orientation uses it.
				this.modes.set(effect.ref, effect.mode);

				return this.workers.get(effect.ref)?.setMode(effect.mode);
			case 'worker_reload':
				return this.workers.get(effect.ref)?.reload(effect.kind, Boolean(effect.force));
			case 'worker_set_model':
				return this.workers.get(effect.ref)?.setModel(effect.model);
			case 'side_answer':
				return this.answerAside(effect);
			case 'session_fork':
				return this.answerSessionAsk(effect);
			case 'secret_transfer':
				return this.copySecret(effect);
			case 'session_ask_answered':
				if (!this.peers.answer(effect.id, { text: effect.text, files: effect.files })) {
					log.debug('peer answer for no waiting call', { ref: effect.ref, id: effect.id });
				}

				return;
			case 'resolve_ask':
				if (!this.permissions.answer(effect.askId, effect.result)) {
					log.debug('ask already settled', { askId: effect.askId });
				}

				return;
			default:
				return;
		}
	};

	// The words' note and where their files are on this machine, read ahead of the words.
	private noteFor({ ref, note, attachments }: Extract<Effect, { type: 'worker_send' }>) {
		const dir = this.options.attachmentsDir;

		if (!attachments?.length || !dir) {
			return note;
		}

		const paths = attachments.flatMap((attachment) => {
			const path = resolveAttachment(dir, attachment.id);

			if (!path) {
				log.warn('attachment not on this machine', { ref, id: attachment.id });
			}

			return path ? [path] : [];
		});

		if (paths.length === 0) {
			return note;
		}

		return [note, describeAttached(paths)].filter(Boolean).join('\n\n');
	}

	private receiveChunk({
		ref,
		id,
		index,
		total,
		base64,
	}: Extract<Effect, { type: 'attachment_chunk' }>) {
		const dir = this.options.attachmentsDir;

		if (!dir) {
			return;
		}

		const outcome = writeChunk({ dir, id, index, total, base64 });

		if (outcome === 'refused') {
			log.warn('attachment chunk refused', { ref, id, index, total });
		} else if (outcome === 'done') {
			log.info('attachment received', { ref, id });
		}
	}

	private async answerAside({
		ref,
		itemId,
		question,
		note,
	}: Extract<Effect, { type: 'side_answer' }>): Promise<void> {
		const worker = this.workers.get(ref);
		const outcome = worker
			? await runSideAnswer({
					launch: worker.launch,
					sessionId: worker.id,
					// Read ahead of the question, as a turn reads it (worker.send).
					question: note ? `${note}\n\n${question}` : question,
					runQuery: this.options.runQuery,
				})
			: ({ status: 'queued', reason: 'no running session' } as const);

		this.options.emit({
			type: 'aside_settled',
			ref,
			itemId,
			question,
			status: outcome.status,
			answer: outcome.status === 'answered' ? outcome.answer : null,
			...(isChangingWork(outcome) ? { isChangingWork: true } : {}),
		});
	}

	// Another session's ask: a read-only copy of this one answers; the session itself goes on.
	private async answerSessionAsk({
		ref,
		id,
		fromLabel,
		question,
	}: Extract<Effect, { type: 'session_fork' }>): Promise<void> {
		const worker = this.workers.get(ref);
		const outcome = worker
			? await runSessionAskFork({
					launch: worker.launch,
					sessionId: worker.id,
					fromLabel,
					question,
					...(this.options.runQuery ? { runQuery: this.options.runQuery } : {}),
				})
			: { status: 'failed' as const, answer: 'it is not running', files: [], read: [] };
		const { attachmentsDir, mediaDir } = this.options;
		const handed = worker
			? storeSessionFiles({
					paths: outcome.files,
					roots: { cwd: worker.launch.cwd, dirs: worker.launch.dirs },
					...(attachmentsDir ? { attachmentsDir } : {}),
					...(mediaDir ? { mediaDir } : {}),
				})
			: { files: [], refused: [] };
		const refusedNote = handed.refused.length
			? `\n\n(Not handed over: ${handed.refused.join('; ')}.)`
			: '';

		this.options.emit({
			type: 'session_fork_settled',
			ref,
			id,
			status: outcome.status,
			answer: `${outcome.answer}${outcome.status === 'answered' ? refusedNote : ''}`,
			files: handed.files,
			read: outcome.read,
		});
	}

	private copySecret({ ref, id, what, toRef }: Extract<Effect, { type: 'secret_transfer' }>): void {
		const session = this.options.readSession(ref);
		const read = session
			? readSecret(what, { cwd: session.cwd, dirs: session.dirs })
			: ({ ok: false, reason: 'that session is not on this machine' } as const);

		if (!read.ok || !this.options.onSecret) {
			const reason = read.ok ? 'secrets cannot be copied from here' : read.reason;

			log.info('secret not copied', { ref, id, reason });
			this.options.emit({ type: 'secret_transferred', ref, id, path: null, reason });

			return;
		}

		// The name and size only: never the value.
		log.info('secret read', { ref, id, bytes: read.bytes.length });
		this.options.onSecret({ id, toRef, name: read.name, bytes: read.bytes });
	}

	listRunning(): string[] {
		return [...this.workers.keys()];
	}

	stopAll(): void {
		this.pendingStarts.clear();

		for (const ref of [...this.workers.keys()]) {
			this.stop(ref);
		}
	}

	private async loadOrientation(ref: string): Promise<string> {
		try {
			return await this.options.fetchOrientation(ref);
		} catch (error) {
			log.warn('no orientation prompt', { ref, error: String(error) });

			return '';
		}
	}

	private async start(ref: string): Promise<void> {
		const { readSession, registryFile, home } = this.options;

		if (!readSession(ref) || this.workers.has(ref) || this.pendingStarts.has(ref)) {
			return;
		}

		// The generation per ref lets a stop during the orientation wait win, and stops a twin spawn.
		const generation = ++this.generation;

		this.pendingStarts.set(ref, generation);

		const orientation = await this.loadOrientation(ref);

		if (this.pendingStarts.get(ref) !== generation) {
			log.info('start cancelled while preparing', { ref });

			return;
		}

		this.pendingStarts.delete(ref);

		const session = readSession(ref);

		if (!session || session.status === 'stopped') {
			return;
		}

		const record = loadRegistry(registryFile)[ref];
		const resumeId = record?.sessionId ?? null;
		const worker = new Worker({
			ref,
			cwd: session.cwd,
			dirs: session.dirs,
			...(this.options.mediaDir ? { mediaDir: this.options.mediaDir } : {}),
			isPinned: session.isPinned,
			// Even without crew's orientation, a session must know it is driven by voice.
			orientation: appendVoiceContext(orientation),
			resumeId,
			env: buildWorkerEnv({
				base: process.env,
				ref,
				home,
				shouldKeepApiKey: this.options.shouldKeepApiKey ?? false,
			}),
			permissions: this.permissions,
			emit: (observation) => {
				if (observation.type === 'worker_exited' && this.workers.get(ref) === worker) {
					this.workers.delete(ref);
					this.ended(ref);
				}

				this.options.emit(observation);
			},
			onSessionId: (sessionId) =>
				recordSession({ file: registryFile, ref, sessionId, briefing: BRIEFING_VERSION }),
			briefing: {
				pending: Boolean(resumeId) && record?.briefing !== BRIEFING_VERSION,
				onBriefed: () => markBriefed(registryFile, ref, BRIEFING_VERSION),
			},
			onResumeFailed: () => forgetSession(registryFile, ref),
			runQuery: this.options.runQuery,
			model: this.options.model,
			maxBudgetUsd: this.options.maxBudgetUsd,
			permissionMode: this.modes.get(ref) ?? 'auto',
			claudeBin: this.options.claudeBin,
			// The setup session lives in Set up's chat, out of the other sessions' reach.
			...(session.isPinned
				? {}
				: {
						peerServer: () => this.peers.serverFor(ref, { cwd: session.cwd, dirs: session.dirs }),
					}),
		});

		this.workers.set(ref, worker);
		worker.start();
	}

	private stop(ref: string): void {
		this.pendingStarts.delete(ref);

		const worker = this.workers.get(ref);

		if (!worker) {
			return;
		}

		this.workers.delete(ref);
		worker.stop();
		this.ended(ref);
	}

	// Stopped or exited, it waits on no other session any more, and its secret copies go.
	private ended(ref: string): void {
		this.peers.settleRef(ref, 'The session ended.');

		if (this.options.secretsDir) {
			removeSessionSecrets(this.options.secretsDir, ref);
		}
	}
}
