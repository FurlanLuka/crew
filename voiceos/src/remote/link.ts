// The main's end of one machine's link: SSH to it, keep it up, and carry effects out and reports in.

import { createLogger } from '../log.js';
import type { CrewRunOptions, CrewRunResult } from '../crew/adapter.js';
import { describeRecap, listWaitingRefs, readSessionLabel } from '../shared/machines.js';
import type { MachineConfig, Observation, State, WorktreeInfo } from '../shared/protocol.js';
import type { HandsEffect } from './mapping.js';
import { toMainInput } from './mapping.js';
import {
	ackOutbox,
	classifyExit,
	lastLine,
	createOutbox,
	nextBackoff,
	pushEffect,
	type Outbox,
} from './link-state.js';
import {
	PING_MS,
	SILENCE_LIMIT_MS,
	createLineDecoder,
	encodeLine,
	parseRemoteLine,
	type RemoteMessage,
	type Snapshot,
} from './protocol.js';
import { planResync } from './resync.js';
import type { UpdateRemote } from './ssh.js';
import { decideVersionFix, readRemoteVersion } from './versions.js';

const log = createLogger('remote');

const ERROR_RETRY_MS = 60_000;
const CALL_TIMEOUT_MS = 90_000;
// A dev check may wait a minute for servers to decide; the call waits past that.
const CALL_MARGIN_MS = 15_000;

export interface Transport {
	write: (text: string) => void;
	close: () => void;
}

export interface TransportHandlers {
	onData: (chunk: Uint8Array | string) => void;
	onExit: (code: number | null, stderr: string) => void;
}

export type OpenTransport = (host: string, handlers: TransportHandlers) => Transport;

export interface RemoteLinkOptions {
	machine: MachineConfig;
	version: string;
	mainId: string;
	runId: string;
	open: OpenTransport;
	getState: () => State;
	dispatch: (input: Observation) => void;
	setWorktrees: (machine: string, worktrees: WorktreeInfo[]) => void;
	storeMedia: (name: string, bytes: Buffer) => boolean;
	say: (text: string) => void;
	// crew update on that machine, when it runs an older release than this one.
	updateRemote: UpdateRemote;
	now?: () => number;
	// Tests reconnect at once.
	retryMs?: number;
}

interface VersionRefusal {
	remote: string | null;
	detail: string;
}

interface PendingCall {
	resolve: (result: CrewRunResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class RemoteLink {
	private transport: Transport | null = null;
	private outbox: Outbox = createOutbox();
	private isReady = false;
	private isStopped = false;
	private hasConnected = false;
	private attempt = 0;
	private lastHeard = 0;
	private refusedDetail: string | null = null;
	private versionRefusal: VersionRefusal | null = null;
	// Remote versions this run already updated from, with how it went: an update is never repeated
	// on every reconnect, and a daemon kept busy on the old release is waited for, not updated again.
	private updates = new Map<string, { ok: true } | { ok: false; reason: string }>();
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private calls = new Map<number, PendingCall>();
	private nextCallId = 1;

	constructor(private options: RemoteLinkOptions) {}

	get id(): string {
		return this.options.machine.id;
	}

	rename(name: string): void {
		if (name !== this.options.machine.name) {
			this.options = { ...this.options, machine: { ...this.options.machine, name } };
		}
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	start(): void {
		this.isStopped = false;
		this.connect();
	}

	stop(): void {
		this.isStopped = true;

		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
		}

		this.transport?.close();
		this.disconnected();
	}

	send(effect: HandsEffect): void {
		const pushed = pushEffect(this.outbox, effect);

		this.outbox = pushed.outbox;
		log.info('effect out', {
			machine: this.id,
			seq: pushed.sent.seq,
			type: effect.type,
			ref: effect.ref,
		});

		// Not ready: it rides in the next hello.
		if (this.isReady) {
			this.write({ type: 'effect', seq: pushed.sent.seq, effect });
		}
	}

	// crew run on that machine (dev servers, the fix prompt), the answer read as if run here.
	runCrew = (args: string[], options?: CrewRunOptions): Promise<CrewRunResult> => {
		if (!this.isReady) {
			return Promise.reject(new Error(`${this.options.machine.name} is out of reach`));
		}

		const id = this.nextCallId++;
		const waitMs = options?.timeoutMs ? options.timeoutMs + CALL_MARGIN_MS : CALL_TIMEOUT_MS;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.calls.delete(id);
				reject(new Error('the remote did not answer'));
			}, waitMs);

			this.calls.set(id, { resolve, reject, timer });
			this.write({
				type: 'call',
				id,
				method: 'crew',
				args,
				...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
			});
		});
	};

	private write(message: Parameters<typeof encodeLine>[0]): void {
		this.transport?.write(encodeLine(message));
	}

	private status(
		status: 'connecting' | 'unreachable' | 'error',
		detail: string | null = null,
	): void {
		this.options.dispatch({ type: 'machine_status', id: this.id, status, detail });
	}

	private connect(): void {
		if (this.isStopped) {
			return;
		}

		const { machine } = this.options;
		let hasHello = false;

		log.info('connecting', { machine: machine.id, host: machine.host, attempt: this.attempt });

		// A retry keeps "out of reach" and its time: the card says how long, not the last attempt.
		const current = this.options.getState().machines[machine.id]?.status;

		if (current !== 'unreachable' && current !== 'error') {
			this.status('connecting');
		}

		this.refusedDetail = null;
		this.versionRefusal = null;
		this.lastHeard = this.now();

		const decode = createLineDecoder((line) => {
			// A login banner without a newline runs into the hello on the same line.
			const start = hasHello ? 0 : line.indexOf('{"type":');
			const parsed = parseRemoteLine(start > 0 ? line.slice(start) : line);

			this.lastHeard = this.now();

			if (!parsed.ok) {
				// A login banner comes before the first message; anything later is worth a warning.
				log[hasHello ? 'warn' : 'debug']('line dropped', {
					machine: machine.id,
					error: parsed.error,
				});

				return;
			}

			if (parsed.message.type === 'hello') {
				hasHello = true;
			}

			this.receive(parsed.message);
		});

		this.transport = this.options.open(machine.host, {
			onData: decode,
			onExit: (code, stderr) => this.exited(code, stderr),
		});
		this.write({
			type: 'hello',
			version: this.options.version,
			mainId: this.options.mainId,
			runId: this.options.runId,
			pending: this.outbox.unacked,
		});
		this.pingTimer = setInterval(() => this.heartbeat(), PING_MS);
	}

	private heartbeat(): void {
		if (this.now() - this.lastHeard > SILENCE_LIMIT_MS) {
			log.warn('remote silent, reconnecting', { machine: this.id });
			this.transport?.close();

			return;
		}

		this.write({ type: 'ping' });
	}

	private receive(message: RemoteMessage): void {
		switch (message.type) {
			case 'hello':
				this.ready(message.snapshot);

				return;
			case 'refused':
				log.warn('refused', { machine: this.id, reason: message.reason });
				this.refusedDetail = message.detail;

				if (message.reason === 'version') {
					this.versionRefusal = { remote: readRemoteVersion(message), detail: message.detail };
				}

				this.transport?.close();

				return;
			case 'ack':
				this.outbox = ackOutbox(this.outbox, message.upTo);

				return;
			case 'input': {
				const input = toMainInput(this.id, message.input);

				if (input) {
					this.options.dispatch(input);
				}

				return;
			}
			case 'worktrees':
				this.options.setWorktrees(this.id, message.worktrees);

				return;
			case 'media':
				if (!this.options.storeMedia(message.name, Buffer.from(message.base64, 'base64'))) {
					log.warn('media refused', { machine: this.id, name: message.name });
				}

				return;
			case 'result': {
				const call = this.calls.get(message.id);

				// A late answer to a call that already gave up is dropped.
				if (!call) {
					return;
				}

				this.calls.delete(message.id);
				clearTimeout(call.timer);

				if (message.ok) {
					call.resolve(message.value);
				} else {
					call.reject(new Error(message.error));
				}

				return;
			}
			case 'pong':
				return;
		}
	}

	private ready(snapshot: Snapshot): void {
		const { machine } = this.options;

		// Its refs exist on the main before anything about them is applied.
		this.options.setWorktrees(this.id, snapshot.worktrees);

		const plan = planResync(this.options.getState(), this.id, snapshot);

		// Ready first: what the resync sends (a queue head, an answer) goes out as it is decided.
		this.isReady = true;
		this.attempt = 0;
		this.options.dispatch({ type: 'machine_resynced', id: this.id, inputs: plan.inputs });

		const after = this.options.getState();
		const labelOf = (ref: string): string => readSessionLabel(after, ref);
		const finished = plan.finished.map(labelOf);
		const waiting = listWaitingRefs(after, this.id).map(labelOf);

		log.info('connected', {
			machine: this.id,
			inputs: plan.inputs.length,
			finished: finished.length,
			waiting: waiting.length,
			pending: this.outbox.unacked.length,
		});

		// The first connect after starting says nothing unless something waits.
		if (this.hasConnected || finished.length > 0 || waiting.length > 0) {
			this.options.say(describeRecap({ name: machine.name, finished, waiting }));
		}

		this.hasConnected = true;
	}

	private disconnected(): void {
		this.isReady = false;
		this.transport = null;

		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}

		for (const call of this.calls.values()) {
			clearTimeout(call.timer);
			call.reject(new Error(`${this.options.machine.name} went out of reach`));
		}

		this.calls.clear();
	}

	private exited(code: number | null, stderr: string): void {
		this.disconnected();

		if (this.isStopped) {
			return;
		}

		if (this.versionRefusal) {
			void this.fixVersion(this.versionRefusal);

			return;
		}

		const failure = this.refusedDetail
			? { status: 'error' as const, detail: this.refusedDetail }
			: classifyExit(this.options.machine.host, code, stderr);
		const delay =
			this.options.retryMs ??
			(failure.status === 'error' ? ERROR_RETRY_MS : nextBackoff(this.attempt));

		log.warn('link closed', {
			machine: this.id,
			code,
			status: failure.status,
			detail: failure.detail,
			retryMs: delay,
		});
		this.status(failure.status, failure.detail);
		this.attempt++;
		this.retryTimer = setTimeout(() => this.connect(), delay);
	}

	private retryLater(
		status: 'connecting' | 'error',
		detail: string,
		delay = this.options.retryMs ?? ERROR_RETRY_MS,
	): void {
		this.status(status, detail);
		this.attempt++;
		this.retryTimer = setTimeout(() => this.connect(), delay);
	}

	// The two releases differ, so the remote refused. One that is behind is updated from here once; its
	// daemon moves to the new release on the next connect, as soon as none of its sessions is working.
	private async fixVersion(refusal: VersionRefusal): Promise<void> {
		const { name, host } = this.options.machine;
		const { version } = this.options;
		const fix = decideVersionFix(version, refusal.remote);
		const tried = refusal.remote === null ? undefined : this.updates.get(refusal.remote);

		log.info('version mismatch', {
			machine: this.id,
			main: version,
			remote: refusal.remote,
			fix,
			tried: tried ? (tried.ok ? 'updated' : 'failed') : 'no',
		});

		if (fix === 'update-main') {
			this.retryLater(
				'error',
				`${name} runs Voice OS ${refusal.remote}, newer than this one (${version}): run crew update here, then crew voice restart.`,
			);

			return;
		}

		if (fix === 'none' || refusal.remote === null) {
			this.retryLater('error', refusal.detail);

			return;
		}

		if (tried) {
			this.retryLater(
				tried.ok ? 'connecting' : 'error',
				tried.ok
					? `${name} is updated; it switches to ${version} once its sessions finish their work.`
					: tried.reason,
			);

			return;
		}

		this.status('connecting', `Updating ${name} to ${version}…`);
		log.info('updating remote', { machine: this.id, from: refusal.remote, to: version });

		const result = await this.options
			.updateRemote(host)
			.catch((error: unknown) => ({ code: null, output: String(error) }));

		if (this.isStopped) {
			return;
		}

		if (result.code === 0) {
			log.info('remote updated', { machine: this.id, to: version });
			this.updates.set(refusal.remote, { ok: true });
			this.attempt = 0;
			this.connect();

			return;
		}

		const why = lastLine(result.output) || `exit ${result.code}`;
		const reason = `Could not update ${name}: ${why}. Run crew update there, then crew voice remote.`;

		log.warn('remote update failed', { machine: this.id, code: result.code, why });
		this.updates.set(refusal.remote, { ok: false, reason });
		this.retryLater('error', reason);
	}
}
