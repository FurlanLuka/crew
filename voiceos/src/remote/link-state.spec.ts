import { describe, expect, it } from 'bun:test';
import { ackOutbox, classifyExit, createOutbox, nextBackoff, pushEffect } from './link-state.js';

describe('outbox', () => {
	it('sent effects wait until acknowledged', () => {
		let outbox = createOutbox();

		outbox = pushEffect(outbox, { type: 'worker_start', ref: 'a/b' }).outbox;
		outbox = pushEffect(outbox, { type: 'worker_stop', ref: 'a/b' }).outbox;
		expect(outbox.unacked.map((sent) => sent.seq)).toEqual([1, 2]);
		expect(ackOutbox(outbox, 1).unacked.map((sent) => sent.seq)).toEqual([2]);
	});
});

describe('nextBackoff', () => {
	it('grows, then holds at 30 s', () => {
		expect([0, 1, 2, 3, 4, 9].map(nextBackoff)).toEqual([
			1_000, 2_000, 5_000, 10_000, 30_000, 30_000,
		]);
	});
});

describe('classifyExit', () => {
	it.each([
		[
			'crew-remote-error: requirements: tmux, claude',
			127,
			'error',
			'Missing on that machine: tmux, claude.',
		],
		[
			'crew-remote-error: cockpit-running',
			4,
			'error',
			'That machine runs Voice OS as a main, not as a remote.',
		],
		[
			'Host key verification failed.',
			255,
			'error',
			'Its host key is not trusted yet: run ssh vm1 once in a terminal.',
		],
		[
			'dev@vm1: Permission denied (publickey).',
			255,
			'error',
			'SSH refused the login: check your key or ssh-agent.',
		],
		[
			'sh: 1: exec: /home/dev/.local/bin/crew: not found',
			127,
			'error',
			'crew is not installed there: install it, then run crew server remote.',
		],
		[
			'ssh: Could not resolve hostname vm1: nodename nor servname provided',
			255,
			'unreachable',
			'Host vm1 not found.',
		],
		[
			'ssh: connect to host vm1 port 22: Connection refused',
			255,
			'unreachable',
			'ssh: connect to host vm1 port 22: Connection refused',
		],
		['', 0, 'unreachable', 'The link closed.'],
		[
			'crew-remote-error: daemon-not-listening: the remote daemon exited during start',
			5,
			'error',
			'Its Voice OS did not start: run crew server remote there.',
		],
		[
			'crew-remote-error: install: no release for linux/riscv64',
			6,
			'error',
			'Voice OS could not be installed there: no release for linux/riscv64.',
		],
	] as [string, number, 'error' | 'unreachable', string][])(
		'%s → %s',
		(stderr, code, status, detail) => {
			expect(classifyExit('vm1', code, stderr)).toEqual({ status, detail });
		},
	);
});
