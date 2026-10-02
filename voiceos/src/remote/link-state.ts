// The main's side of a link, the parts worth testing without a process: what it still owes the
// remote, how long it waits before trying again, and what an SSH failure means to the developer.

import type { MachineStatus } from '../shared/protocol.js';
import type { HandsEffect } from './mapping.js';
import type { SequencedEffect } from './protocol.js';

// Effects sent and not yet acknowledged: they go again in the next hello, and the remote skips any
// it already applied.
export interface Outbox {
	nextSeq: number;
	unacked: SequencedEffect[];
}

export const createOutbox = (): Outbox => ({ nextSeq: 1, unacked: [] });

export const pushEffect = (
	outbox: Outbox,
	effect: HandsEffect,
): { outbox: Outbox; sent: SequencedEffect } => {
	const sent = { seq: outbox.nextSeq, effect };

	return { outbox: { nextSeq: outbox.nextSeq + 1, unacked: [...outbox.unacked, sent] }, sent };
};

export const ackOutbox = (outbox: Outbox, upTo: number): Outbox => ({
	...outbox,
	unacked: outbox.unacked.filter((sent) => sent.seq > upTo),
});

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export const nextBackoff = (attempt: number): number =>
	BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;

export interface LinkFailure {
	status: Extract<MachineStatus, 'unreachable' | 'error'>;
	detail: string;
	// error: something the developer must fix there; retried slowly.
}

const lastLine = (text: string): string =>
	text
		.trim()
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1) ?? '';

// Why the SSH link ended, in words the developer can act on. crew voice _attach reports its own
// refusals as "crew-remote-error: <kind>" lines.
export const classifyExit = (host: string, code: number | null, stderr: string): LinkFailure => {
	const requirements = stderr.match(/crew-remote-error: requirements: (.+)/)?.[1]?.trim();

	if (requirements) {
		return { status: 'error', detail: `Missing on that machine: ${requirements}.` };
	}

	if (stderr.includes('crew-remote-error: cockpit-running')) {
		return { status: 'error', detail: 'That machine runs Voice OS as a main, not as a remote.' };
	}

	const install = stderr.match(/crew-remote-error: install: (.+)/)?.[1]?.trim();

	if (install) {
		return { status: 'error', detail: `Voice OS could not be installed there: ${install}.` };
	}

	if (stderr.includes('crew-remote-error: daemon-not-listening')) {
		return { status: 'error', detail: 'Its Voice OS did not start: run crew server remote there.' };
	}

	if (stderr.includes('Host key verification failed')) {
		return {
			status: 'error',
			detail: `Its host key is not trusted yet: run ssh ${host} once in a terminal.`,
		};
	}

	if (stderr.includes('Permission denied')) {
		return { status: 'error', detail: 'SSH refused the login: check your key or ssh-agent.' };
	}

	if (code === 127 || /crew: (?:command )?not found|No such file or directory/.test(stderr)) {
		return {
			status: 'error',
			detail: 'crew is not installed there: install it, then run crew server remote.',
		};
	}

	if (stderr.includes('Could not resolve hostname')) {
		return { status: 'unreachable', detail: `Host ${host} not found.` };
	}

	const line = lastLine(stderr);

	return { status: 'unreachable', detail: line || 'The link closed.' };
};
