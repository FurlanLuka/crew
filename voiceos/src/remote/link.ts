// The main's end of one machine's link: SSH to it, keep it up, and carry effects out and reports in.

import { createLogger } from '../log.js';
import type { CrewRunOptions, CrewRunResult, CrewRunner } from '../crew/adapter.js';
import { describeRecap, listWaitingRefs, readSessionLabel } from '../shared/machines.js';
import type { MachineConfig, Observation, State, WorktreeInfo } from '../shared/protocol.js';
import type { HandsEffect } from './mapping.js';
import { toMainInput } from './mapping.js';
import {
	ackOutbox,
	classifyExit,
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
	type CrewCall,
	type RemoteMessage,
	type Snapshot,
} from './protocol.js';
import { PendingCalls } from './pending-calls.js';
import { planResync } from './resync.js';
import type { UpdateRemote } from './ssh.js';
import {
	planVersionFix,
	readRemoteVersion,
	readUpdateOutcome,
	type UpdateOutcome,
} from './versions.js';

const log = createLogger('remote');

const ERROR_RETRY_MS = 60_000;
const CALL_TIMEOUT_MS = 90_000;
// A dev check may wait a minute for servers to decide; the call waits past that.
const CALL_MARGIN_MS = 15_000;
// A remote's query runs crew here, which may ask every machine over SSH (20 s each); the remote's
// daemon waits 30 s for the answer.
const QUERY_TIMEOUT_MS = 25_000;
// Past this the answer is refused whole, never cut into JSON that does not parse.
const MAX_QUERY_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_LINES = 1000;

const QUERY_VALUE_FLAGS = new Set([
	'--since',
	'--until',
	'--cat',
	'--level',
	'--grep',
	'--machine',
	'--exclude',
	'--around',
]);
const QUERY_BARE_FLAGS = new Set(['--all', '--json']);

const isQueryFlag = (arg: string): boolean => {
	const equals = arg.indexOf('=');

	if (equals < 0) {
		return QUERY_BARE_FLAGS.has(arg);
	}

	const name = arg.slice(0, equals);
	const value = arg.slice(equals + 1);

	if (name === '--lines') {
		return /^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_QUERY_LINES;
	}

	return QUERY_VALUE_FLAGS.has(name);
};

const areQueryPositionals = (command: string, positionals: string[]): boolean => {
	switch (command) {
		case 'logs':
			return positionals.length === 0;
		case 'notes':
			return positionals.length <= 1;
		case 'debug-notes':
			return (
				positionals.length === 0 ||
				(positionals.length === 2 &&
					positionals[0] === 'show' &&
					/^\d+$/.test(positionals[1] ?? ''))
			);
		default:
			return false;
	}
};

// What a remote may run here: reading Voice OS's logs, notes and debug notes — never --local (the
// main answers for every machine) and nothing that changes anything.
export const isAllowedQuery = (args: string[]): boolean => {
	const [voice, command, ...rest] = args;

	if (voice !== 'voice' || !command) {
		return false;
	}

	const positionals = rest.filter((arg) => !arg.startsWith('-'));
	const flags = rest.filter((arg) => arg.startsWith('-'));

	return areQueryPositionals(command, positionals) && flags.every(isQueryFlag);
};

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
	// This machine's own crew, for what a remote asks the main (crew voice logs there).
	runLocalCrew: CrewRunner;
	now?: () => number;
	// Tests reconnect at once.
	retryMs?: number;
}

interface VersionRefusal {
	remote: string | null;
	detail: string;
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
	private updates = new Map<string, UpdateOutcome>();
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private calls = new PendingCalls<CrewRunResult>();
	// A remote's queries run one at a time: each spawns crew and its SSH fan-out.
	private queries: Promise<void> = Promise.resolve();

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

		const { id, promise } = this.calls.open({
			timeoutMs: options?.timeoutMs ? options.timeoutMs + CALL_MARGIN_MS : CALL_TIMEOUT_MS,
			onTimeout: () => new Error('the remote did not answer'),
		});

		this.write({
			type: 'call',
			id,
			method: 'crew',
			args,
			...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
		});

		return promise;
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
			case 'result':
				// A late answer to a call that already gave up is dropped.
				this.calls.settle(
					message.id,
					message.ok
						? { ok: true, value: message.value }
						: { ok: false, error: new Error(message.error) },
				);

				return;
			case 'call': {
				const transport = this.transport;

				if (transport) {
					this.queries = this.queries.then(() => this.answerQuery(message, transport));
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

		this.calls.rejectAll(new Error(`${this.options.machine.name} went out of reach`));
	}

	// Runs a remote's query with this machine's crew and relays its output as it is: the remote's crew
	// prints it and exits with its code, so there it reads exactly as it would here.
	private async answerQuery(call: CrewCall, transport: Transport): Promise<void> {
		const reply = (message: Parameters<typeof encodeLine>[0]): void => {
			// Only on the link that asked: after a reconnect nobody waits for it.
			if (this.transport === transport) {
				transport.write(encodeLine(message));
			}
		};

		const command = call.args.slice(0, 2).join(' ');

		// Queued behind another query while the link dropped: whoever asked is gone.
		if (this.transport !== transport) {
			return;
		}

		if (!isAllowedQuery(call.args)) {
			log.warn('query refused', { machine: this.id, command });
			reply({ type: 'result', id: call.id, ok: false, error: 'not allowed' });

			return;
		}

		const startedAt = this.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`crew did not answer in ${QUERY_TIMEOUT_MS / 1000}s`)),
				QUERY_TIMEOUT_MS,
			);
		});

		try {
			const value = await Promise.race([
				this.options.runLocalCrew(call.args, { timeoutMs: QUERY_TIMEOUT_MS }),
				timedOut,
			]);
			const bytes = Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr);

			log.info('query', {
				machine: this.id,
				command,
				code: value.code,
				bytes,
				ms: this.now() - startedAt,
			});

			if (bytes > MAX_QUERY_OUTPUT_BYTES) {
				reply({
					type: 'result',
					id: call.id,
					ok: false,
					error: 'output over 2 MB; narrow the filters',
				});

				return;
			}

			reply({ type: 'result', id: call.id, ok: true, value });
		} catch (error) {
			log.warn('query failed', { machine: this.id, command, error: String(error) });
			reply({ type: 'result', id: call.id, ok: false, error: String(error) });
		} finally {
			clearTimeout(timer);
		}
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

		log.warn('link closed', {
			machine: this.id,
			code,
			status: failure.status,
			detail: failure.detail,
		});
		this.retryLater(failure.status, failure.detail);
	}

	private retryLater(status: 'connecting' | 'unreachable' | 'error', detail: string): void {
		const delay =
			this.options.retryMs ??
			(status === 'unreachable' ? nextBackoff(this.attempt) : ERROR_RETRY_MS);

		this.status(status, detail);
		this.attempt++;
		this.retryTimer = setTimeout(() => this.connect(), delay);
	}

	// The two releases differ, so the remote refused. One that is behind is updated from here once; its
	// daemon moves to the new release on the next connect, at once.
	private async fixVersion(refusal: VersionRefusal): Promise<void> {
		const { name, host } = this.options.machine;
		const plan = planVersionFix({
			main: this.options.version,
			remote: refusal.remote,
			name,
			detail: refusal.detail,
			tried: refusal.remote === null ? undefined : this.updates.get(refusal.remote),
		});

		log.info('version mismatch', {
			machine: this.id,
			main: this.options.version,
			remote: refusal.remote,
			plan: plan.kind === 'update' ? 'update' : plan.status,
		});

		if (plan.kind === 'wait') {
			this.retryLater(plan.status, plan.detail);

			return;
		}

		this.status('connecting', `Updating ${name}…`);
		log.info('updating remote', { machine: this.id, from: plan.from });

		const result = await this.options
			.updateRemote(host)
			.catch((error: unknown) => ({ code: null, output: String(error), isTimedOut: false }));
		const outcome = readUpdateOutcome({ name, ...result });

		this.updates.set(plan.from, outcome);

		if (this.isStopped) {
			return;
		}

		if (!outcome.ok) {
			log.warn('remote update failed', {
				machine: this.id,
				code: result.code,
				reason: outcome.reason,
			});
			this.retryLater('error', outcome.reason);

			return;
		}

		log.info('remote updated', { machine: this.id });
		this.attempt = 0;
		this.connect();
	}
}
