// A remote machine's side: its sessions run here, one main at a time drives them over a link.
// The sessions outlive any link; what happened while no main listened is in the next snapshot.

import { createLogger } from '../log.js';
import type { Observation, SessionStatus, WorktreeInfo } from '../shared/protocol.js';
import type { CrewRunner } from '../crew/adapter.js';
import type { HandsEffect } from './mapping.js';
import {
	acceptEffects,
	buildSnapshot,
	createHostState,
	isBusy,
	openInbox,
	trackEffect,
	trackObservation,
	type HostState,
	type Inbox,
} from './host-state.js';
import {
	encodeLine,
	parseMainLine,
	REMOTE_OBSERVATIONS,
	SILENCE_LIMIT_MS,
	type MainMessage,
	type RemoteMessage,
	type SequencedEffect,
} from './protocol.js';

const log = createLogger('remote');

const DEV_ACTIONS = new Set(['status', 'check', 'start', 'stop', 'restart']);
const DEV_FLAGS = new Set(['--json', '--wait']);

// crew commands a main may run here: exactly what its dev watch sends (CrewAdapter) — dev servers
// looked at, started and stopped, and the fix prompt — never anything that changes what exists.
export const isAllowedCrewCall = (args: string[]): boolean => {
	const [command, action, ...rest] = args;

	if (command === 'fix') {
		return (
			args.length === 3 && action !== undefined && !action.startsWith('-') && rest[0] === '--print'
		);
	}

	if (command !== 'dev' || !action || !DEV_ACTIONS.has(action)) {
		return false;
	}

	const refs = rest.filter((arg) => !arg.startsWith('-'));

	return refs.length <= 1 && rest.every((arg) => !arg.startsWith('-') || DEV_FLAGS.has(arg));
};

export interface Connection {
	write: (text: string) => void;
	close: () => void;
}

export interface HandsManager {
	handle: (effect: HandsEffect) => void | Promise<void>;
	listRunning: () => string[];
}

export interface RemoteHostOptions {
	version: string;
	host: string;
	createManager: (port: {
		readSession: (ref: string) => (WorktreeInfo & { status: SessionStatus }) | undefined;
		emit: (observation: Observation) => void;
	}) => HandsManager;
	listWorktrees: () => Promise<WorktreeInfo[]>;
	runCrew: CrewRunner;
	readGitHead: (cwd: string) => Promise<string | null>;
	readMedia: (name: string) => Uint8Array | null;
	// Sends each recorded session's history through dispatch, for a main that has none yet.
	restoreHistory: (dispatch: (observation: Observation) => void) => Promise<void>;
	onBusyChanged?: (isBusy: boolean) => void;
	now?: () => number;
}

interface Attachment {
	connection: Connection;
	mainId: string | null;
	mediaSent: Set<string>;
	lastHeard: number;
}

export class RemoteHost {
	private state: HostState = createHostState();
	private worktrees: WorktreeInfo[] = [];
	private attached: Attachment | null = null;
	private inbox: Inbox | null = null;
	private manager: HandsManager;
	private reporting: Promise<void> = Promise.resolve();
	private turnCount = 0;
	private readonly bootId: string;
	private wasBusy = false;

	constructor(private options: RemoteHostOptions) {
		this.bootId = (options.now ?? Date.now)().toString(36);
		this.manager = options.createManager({
			readSession: (ref) => {
				const info = this.worktrees.find((worktree) => worktree.ref === ref);

				return info
					? { ...info, status: this.state.sessions[ref]?.status ?? 'stopped' }
					: undefined;
			},
			emit: (observation) => this.report(observation),
		});
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	setWorktrees(worktrees: WorktreeInfo[]): void {
		const isChanged = JSON.stringify(worktrees) !== JSON.stringify(this.worktrees);

		this.worktrees = worktrees;

		if (isChanged && this.attached?.mainId) {
			this.send(this.attached, { type: 'worktrees', worktrees });
		}
	}

	async refreshWorktrees(): Promise<void> {
		try {
			this.setWorktrees(await this.options.listWorktrees());
		} catch (error) {
			log.warn('worktree refresh failed', { error: String(error) });
		}
	}

	// A new link: nothing is sent to it until its hello.
	connect(connection: Connection): { receive: (line: string) => void; closed: () => void } {
		const attachment: Attachment = {
			connection,
			mainId: null,
			mediaSent: new Set(),
			lastHeard: this.now(),
		};

		log.info('link opened');

		return {
			receive: (line) => this.receive(attachment, line),
			closed: () => {
				if (this.attached === attachment) {
					this.attached = null;
					log.info('main detached', { mainId: attachment.mainId });
				}
			},
		};
	}

	// Drops a main that stopped talking: its reconnect must not find this one still holding on.
	dropSilent(): void {
		const attached = this.attached;

		if (attached && this.now() - attached.lastHeard > SILENCE_LIMIT_MS) {
			log.warn('main silent, detached', { mainId: attached.mainId });
			this.attached = null;
			attached.connection.close();
		}
	}

	private send(attachment: Attachment, message: RemoteMessage): void {
		attachment.connection.write(encodeLine(message));
	}

	private receive(attachment: Attachment, line: string): void {
		const parsed = parseMainLine(line);

		attachment.lastHeard = this.now();

		if (!parsed.ok) {
			log.warn('line dropped', { error: parsed.error, chars: line.length });

			return;
		}

		const message: MainMessage = parsed.message;

		if (message.type === 'hello') {
			this.hello(attachment, message);

			return;
		}

		if (this.attached !== attachment) {
			log.warn('message from a main that is not attached', { type: message.type });

			return;
		}

		switch (message.type) {
			case 'effect':
				this.apply([{ seq: message.seq, effect: message.effect }]);

				return;
			case 'call':
				void this.call(attachment, message);

				return;
			case 'ping':
				this.send(attachment, { type: 'pong' });

				return;
		}
	}

	private hello(attachment: Attachment, message: Extract<MainMessage, { type: 'hello' }>): void {
		if (message.version !== this.options.version) {
			log.warn('main refused: version', { main: message.version, here: this.options.version });
			this.send(attachment, {
				type: 'refused',
				reason: 'version',
				detail: `This machine runs Voice OS ${this.options.version} and the main ${message.version}: run crew update on the older one, then crew voice remote there.`,
			});
			attachment.connection.close();

			return;
		}

		const current = this.attached;

		if (current && current !== attachment && current.mainId !== message.mainId) {
			log.warn('main refused: held', { mainId: message.mainId, holder: current.mainId });
			this.send(attachment, {
				type: 'refused',
				reason: 'held',
				detail: 'Another Voice OS drives this machine.',
			});
			attachment.connection.close();

			return;
		}

		// The same main again (its old link never closed): the new link takes over.
		if (current && current !== attachment) {
			log.info('main took over its own stale link', { mainId: message.mainId });
			current.connection.close();
		}

		const isNewRun = this.inbox?.runId !== message.runId;

		attachment.mainId = message.mainId;
		this.attached = attachment;
		this.inbox = openInbox(this.inbox, message.mainId, message.runId);
		// What the main sent into the old link is applied first, so the snapshot already shows it.
		this.apply(message.pending);

		const snapshot = buildSnapshot(this.state, this.worktrees);

		log.info('main attached', {
			mainId: message.mainId,
			pending: message.pending.length,
			sessions: snapshot.sessions.length,
			asks: snapshot.asks.length,
		});
		this.send(attachment, {
			type: 'hello',
			version: this.options.version,
			host: this.options.host,
			snapshot,
		});

		if (isNewRun) {
			void this.options.restoreHistory((observation) => {
				if (this.attached !== attachment) {
					return;
				}

				if (observation.type === 'history_restored') {
					for (const item of observation.items) {
						if (item.kind === 'image') {
							this.sendMedia(attachment, item.name);
						}
					}
				}

				this.send(attachment, { type: 'input', input: observation });
			});
		}
	}

	private apply(sequenced: SequencedEffect[]): void {
		if (!this.inbox || sequenced.length === 0) {
			return;
		}

		const accepted = acceptEffects(this.inbox, sequenced);

		this.inbox = accepted.inbox;

		for (const effect of accepted.effects) {
			log.info('effect', { type: effect.type, ref: effect.ref });
			this.state = trackEffect(this.state, effect);

			// A send to a session that is not running here (it restarted): the main learns it stopped.
			if (effect.type === 'worker_send' && !this.manager.listRunning().includes(effect.ref)) {
				this.report({ type: 'worker_exited', ref: effect.ref, error: 'It was not running.' });

				continue;
			}

			void this.manager.handle(effect);
		}

		if (this.attached) {
			this.send(this.attached, { type: 'ack', upTo: this.inbox.lastSeq });
		}
	}

	private async call(
		attachment: Attachment,
		message: Extract<MainMessage, { type: 'call' }>,
	): Promise<void> {
		const startedAt = this.now();

		if (!isAllowedCrewCall(message.args)) {
			log.warn('crew call refused', { args: message.args[0] });
			this.send(attachment, { type: 'result', id: message.id, ok: false, error: 'not allowed' });

			return;
		}

		try {
			const value = await this.options.runCrew(
				message.args,
				message.timeoutMs ? { timeoutMs: message.timeoutMs } : undefined,
			);

			log.info('crew call', {
				command: message.args.slice(0, 2).join(' '),
				code: value.code,
				ms: this.now() - startedAt,
			});

			if (this.attached === attachment) {
				this.send(attachment, { type: 'result', id: message.id, ok: true, value });
			}
		} catch (error) {
			log.warn('crew call failed', { error: String(error) });

			if (this.attached === attachment) {
				this.send(attachment, { type: 'result', id: message.id, ok: false, error: String(error) });
			}
		}
	}

	// Reports go out in the order they happened, though a turn's end waits on git for its commit.
	private report(observation: Observation): void {
		this.reporting = this.reporting
			.then(() => this.deliver(observation))
			.catch((error) => {
				log.error('report failed', { type: observation.type, error: String(error) });
			});
	}

	private async deliver(observation: Observation): Promise<void> {
		const stamped =
			observation.type === 'turn_ended'
				? {
						...observation,
						turnId: `${this.bootId}-${++this.turnCount}`,
						head: await this.readHead(observation.ref),
					}
				: observation;

		this.state = trackObservation(this.state, stamped);
		this.noteBusy();

		const attached = this.attached;

		// Only reports a main takes from a remote go out (usage limits belong to this machine's login).
		if (!attached?.mainId || !REMOTE_OBSERVATIONS.has(stamped.type)) {
			return;
		}

		if (stamped.type === 'image') {
			this.sendMedia(attached, stamped.name);
		}

		this.send(attached, { type: 'input', input: stamped });
	}

	// An image's bytes go ahead of the report that shows it, once per link.
	private sendMedia(attachment: Attachment, name: string): void {
		if (attachment.mediaSent.has(name)) {
			return;
		}

		const bytes = this.options.readMedia(name);

		if (bytes) {
			this.send(attachment, { type: 'media', name, base64: Buffer.from(bytes).toString('base64') });
			attachment.mediaSent.add(name);
		}
	}

	private async readHead(ref: string): Promise<string | null> {
		const cwd = this.worktrees.find((worktree) => worktree.ref === ref)?.cwd;

		return cwd ? this.options.readGitHead(cwd) : null;
	}

	private noteBusy(): void {
		const busy = isBusy(this.state);

		if (busy !== this.wasBusy) {
			this.wasBusy = busy;
			this.options.onBusyChanged?.(busy);
		}
	}

	stopAll(): void {
		for (const ref of this.manager.listRunning()) {
			void this.manager.handle({ type: 'worker_stop', ref });
		}
	}
}
