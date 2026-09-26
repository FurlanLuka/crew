import type { Store } from '../state/store.js';
import type { Effect } from '../state/reducer.js';
import { createLogger } from '../log.js';
import { PermissionBridge } from './permissions.js';
import { forgetSession, loadRegistry, markBriefed, recordSession } from './registry.js';
import { Worker, buildWorkerEnv, type WorkerOptions } from './worker.js';
import { BRIEFING_VERSION, appendVoiceContext } from './voice-context.js';

const log = createLogger('sessions');

export interface SessionManagerOptions {
	store: Store;
	registryFile: string;
	home: string;
	fetchOrientation: (ref: string) => Promise<string>;
	shouldKeepApiKey?: boolean;
	model?: string;
	maxBudgetUsd?: number;
	permissionMode?: 'auto' | 'default';
	claudeBin?: string;
	runQuery?: WorkerOptions['runQuery'];
}

export class SessionManager {
	// Owns processes, never state: every change it observes goes back through store.dispatch.
	private workers = new Map<string, Worker>();
	private pendingStarts = new Map<string, number>();
	private generation = 0;
	readonly permissions: PermissionBridge;

	constructor(private options: SessionManagerOptions) {
		const { store } = options;

		this.permissions = new PermissionBridge(
			(ask) => store.dispatch({ type: 'ask_opened', ask }),
			(askId) => store.dispatch({ type: 'ask_closed', askId }),
		);
	}

	handle = (effect: Effect): void | Promise<void> => {
		switch (effect.type) {
			case 'worker_start':
				return this.start(effect.ref);
			case 'worker_send':
				return this.workers.get(effect.ref)?.send(effect.text, effect.note);
			case 'worker_stop':
				return this.stop(effect.ref);
			case 'worker_interrupt':
				return this.workers.get(effect.ref)?.interrupt(effect.reason);
			case 'worker_set_mode':
				return this.workers.get(effect.ref)?.setMode(effect.mode);
			case 'resolve_ask':
				if (!this.permissions.answer(effect.askId, effect.result)) {
					log.debug('ask already settled', { askId: effect.askId });
				}

				return;
			default:
				return;
		}
	};

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
		const { store, registryFile, home } = this.options;

		if (!store.state.sessions[ref] || this.workers.has(ref) || this.pendingStarts.has(ref)) {
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

		const session = store.state.sessions[ref];

		if (!session || session.status === 'stopped') {
			return;
		}

		const record = loadRegistry(registryFile)[ref];
		const resumeId = record?.sessionId ?? null;
		const worker = new Worker({
			ref,
			cwd: session.cwd,
			dirs: session.dirs,
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
				}

				store.dispatch(observation);
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
			permissionMode: this.options.permissionMode,
			claudeBin: this.options.claudeBin,
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
	}
}
