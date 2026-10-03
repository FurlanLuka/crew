// A remote machine's side: its sessions run here, one main at a time drives them over a link.
// The sessions outlive any link; what happened while no main listened is in the next snapshot.

import { DISCORD_SEND_WAIT_MS, isDiscordSendQuery } from './query-allow.js';
import { createLogger } from '../log.js';
import type { Observation, SessionStatus, WorktreeInfo } from '../shared/protocol.js';
import type { CrewRunner } from '../crew/adapter.js';
import { parseSetupCommand, toCrewArgv, toCrewStdin, traitsOf } from '../crew/commands.js';
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
import { PendingCalls } from './pending-calls.js';
import type { QueryAnswer, QueryFailureReason } from './query-socket.js';
import {
	encodeLine,
	parseMainLine,
	REMOTE_OBSERVATIONS,
	SILENCE_LIMIT_MS,
	type MainMessage,
	type CrewCall,
	type CrewCallResult,
	type RemoteMessage,
	type SequencedEffect,
} from './protocol.js';

const log = createLogger('remote');

// Inside the main's own 25 s for running crew, and inside crew's 35 s for reading query.sock.
const QUERY_TIMEOUT_MS = 30_000;

// A build from source has no release to update to: the way back to one version is a dev push.
export const describeVersionRefusal = (here: string, main: string): string =>
	here.startsWith('dev') || main.startsWith('dev')
		? `This machine runs Voice OS ${here} and the main ${main}: run crew server dev push from the checkout you want on every machine, or crew update on each to go back to the release.`
		: `This machine runs Voice OS ${here} and the main ${main}: run crew update on the older one, then crew server remote there.`;

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

type PlannedCall =
	| { ok: true; args: string[]; stdin?: string; label: string; timeoutMs?: number }
	| { ok: false; reason: string; error: string };

// What a main's call runs here. A typed Set up command runs whatever crew/commands.ts allows, built
// into argv here — a deliberate widening from the dev-watch allow-list: the main already reaches this
// machine over SSH as the developer, so Set up asking crew for a worktree here grants nothing new.
// Only what would stop, replace or re-key this machine's own server stays the main's own (local-only).
// A call without a command (the dev watch) is judged by isAllowedCrewCall as before. Pure.
export const planCrewCall = (
	message: Pick<CrewCall, 'args' | 'command' | 'timeoutMs'>,
): PlannedCall => {
	if (message.command === undefined) {
		return isAllowedCrewCall(message.args)
			? {
					ok: true,
					args: message.args,
					label: message.args.slice(0, 2).join(' '),
					...(message.timeoutMs ? { timeoutMs: message.timeoutMs } : {}),
				}
			: { ok: false, reason: 'args', error: 'not allowed' };
	}

	const parsed = parseSetupCommand(message.command);

	if (!parsed.ok) {
		return { ok: false, reason: 'invalid command', error: parsed.error };
	}

	if (traitsOf(parsed.command).localOnly) {
		return {
			ok: false,
			reason: 'local only',
			error: `${parsed.command.type} runs only on the main`,
		};
	}

	const stdin = toCrewStdin(parsed.command);

	// The variant's own timeout, not the wire's: the wire stays inside what older remotes accept.
	return {
		ok: true,
		args: toCrewArgv(parsed.command),
		label: parsed.command.type,
		timeoutMs: traitsOf(parsed.command).timeoutMs,
		...(stdin === undefined ? {} : { stdin }),
	};
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
	// Tests shorten it.
	queryTimeoutMs?: number;
}

// Why a query to the main failed, carried to the query socket's answer.
class QueryFailure extends Error {
	constructor(
		readonly reason: QueryFailureReason,
		message: string,
	) {
		super(message);
	}
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
	// This machine's crew asking the main (query.sock); they go when the main does.
	private queries = new PendingCalls<CrewCallResult>();

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
					this.detach();
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
			this.detach();
			attached.connection.close();
		}
	}

	// A query in flight goes with the main that was asked: the answer would come on a link that is gone.
	private detach(): void {
		this.attached = null;
		this.queries.rejectAll(new QueryFailure('no-main', 'the main disconnected'));
	}

	// This machine's crew asking the main to run crew there. Never rejects: every failure is an answer.
	query = (args: string[]): Promise<QueryAnswer> => {
		const attached = this.attached;

		if (!attached?.mainId) {
			return Promise.resolve({
				ok: false,
				reason: 'no-main',
				error: 'the main is not connected',
			});
		}

		const timeoutMs =
			this.options.queryTimeoutMs ??
			(isDiscordSendQuery(args) ? DISCORD_SEND_WAIT_MS : QUERY_TIMEOUT_MS);
		const { id, promise } = this.queries.open({
			timeoutMs,
			onTimeout: () =>
				new QueryFailure('timeout', `the main did not answer in ${Math.round(timeoutMs / 1000)}s`),
		});

		this.send(attached, { type: 'call', id, method: 'crew', args });

		return promise.then(
			(value): QueryAnswer => ({ ok: true, value }),
			(error: unknown): QueryAnswer => ({
				ok: false,
				reason: error instanceof QueryFailure ? error.reason : 'error',
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	};

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
			case 'result':
				// A late answer (the query timed out) finds nothing waiting and is dropped.
				this.queries.settle(
					message.id,
					message.ok
						? { ok: true, value: message.value }
						: { ok: false, error: new QueryFailure('error', message.error) },
				);

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
				version: this.options.version,
				detail: describeVersionRefusal(this.options.version, message.version),
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
			this.detach();
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
			// A file's pieces are said once, when it is whole (the manager's "attachment received").
			if (effect.type !== 'attachment_chunk') {
				log.info('effect', { type: effect.type, ref: effect.ref });
			}

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
		const planned = planCrewCall(message);

		if (!planned.ok) {
			log.warn('crew call refused', { reason: planned.reason });
			this.send(attachment, { type: 'result', id: message.id, ok: false, error: planned.error });

			return;
		}

		try {
			const value = await this.options.runCrew(planned.args, {
				...(planned.timeoutMs ? { timeoutMs: planned.timeoutMs } : {}),
				...(planned.stdin === undefined ? {} : { stdin: planned.stdin }),
			});

			// The command's type and the exit code only: arguments can carry binding values.
			log.info('crew call', {
				command: planned.label,
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
