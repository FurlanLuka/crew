import { describe, expect, it } from 'bun:test';
import type { Observation } from '../shared/protocol.js';
import { REMOTE_OBSERVATIONS } from './protocol.js';
import { routeEffect, toMainInput } from './mapping.js';

describe('routeEffect', () => {
	it('a send to a remote session → that machine, the ref as it knows it, the words intact', () => {
		expect(
			routeEffect({ type: 'worker_send', ref: 'vm1:store/main', text: 'run the tests' }),
		).toEqual({
			kind: 'remote',
			machine: 'vm1',
			effect: { type: 'worker_send', ref: 'store/main', text: 'run the tests' },
		});
	});

	it.each([
		{ type: 'worker_reload' as const, ref: 'vm1:store/main', kind: 'plugins' as const },
		{ type: 'worker_set_model' as const, ref: 'vm1:store/main', model: 'opus' },
	])('$type to a remote session → that machine, the ref as it knows it', (effect) =>
		expect(routeEffect(effect)).toEqual({
			kind: 'remote',
			machine: 'vm1',
			effect: { ...effect, ref: 'store/main' },
		}),
	);

	it('an answer to a remote ask → the ref and the ask id both lose the prefix', () => {
		expect(
			routeEffect({
				type: 'resolve_ask',
				ref: 'vm1:store/main',
				askId: 'vm1:ask-store/main-1-9',
				result: { behavior: 'deny', message: 'no' },
			}),
		).toEqual({
			kind: 'remote',
			machine: 'vm1',
			effect: {
				type: 'resolve_ask',
				ref: 'store/main',
				askId: 'ask-store/main-1-9',
				result: { behavior: 'deny', message: 'no' },
			},
		});
	});

	it('this Mac → local, unchanged', () => {
		const effect = { type: 'worker_start' as const, ref: 'store/main', mode: 'auto' as const };

		expect(routeEffect(effect)).toEqual({ kind: 'local', effect });
	});

	it('speech and dev work stay with the main', () => {
		expect(routeEffect({ type: 'dev', ref: 'vm1:store/main', action: 'start' })).toEqual({
			kind: 'other',
		});
		expect(routeEffect({ type: 'drop_speech', ref: 'vm1:store/main', before: 1 })).toEqual({
			kind: 'other',
		});
	});
});

describe('toMainInput', () => {
	// Every report a remote may make, with a ref where it has one: none may arrive unprefixed.
	const samples: Observation[] = [
		{ type: 'session_started', ref: 'store/main' },
		{ type: 'turn_started', ref: 'store/main' },
		{ type: 'text_delta', ref: 'store/main', text: 'x' },
		{ type: 'assistant_text', ref: 'store/main', text: 'x' },
		{ type: 'tool', ref: 'store/main', name: 'Bash', summary: 'ls' },
		{ type: 'tool_result', ref: 'store/main', ok: true, summary: 'ok' },
		{ type: 'diff', ref: 'store/main', filePath: 'a.ts', lines: [] },
		{ type: 'image', ref: 'store/main', name: 'n.png', alt: '' },
		{ type: 'doc', ref: 'store/main', url: 'https://x', title: 't' },
		{ type: 'turn_ended', ref: 'store/main', costUsd: 0, text: '' },
		{ type: 'denied', ref: 'store/main', toolName: 'Bash', summary: 's' },
		{
			type: 'ask_opened',
			ask: { id: 'ask-store/main-1', ref: 'store/main', at: 1, kind: 'plan', input: {}, plan: 'p' },
		},
		{ type: 'ask_closed', askId: 'ask-store/main-1' },
		{ type: 'worker_exited', ref: 'store/main', error: null },
		{ type: 'history_restored', ref: 'store/main', items: [] },
		{
			type: 'commands_listed',
			ref: 'store/main',
			commands: [{ name: 'review', description: 'Review a change', argumentHint: '<pr>' }],
		},
		{
			type: 'subagent_started',
			ref: 'store/main',
			taskId: 't',
			agentType: null,
			description: 'd',
			isBackground: false,
		},
		{ type: 'subagent_step', ref: 'store/main', taskId: 't', step: 's' },
		{ type: 'subagent_backgrounded', ref: 'store/main', taskId: 't' },
		{ type: 'subagent_ended', ref: 'store/main', taskId: 't' },
		{
			type: 'subagent_item',
			ref: 'store/main',
			taskId: 't',
			item: { kind: 'text', text: 'Found it.' },
		},
		{
			type: 'aside_settled',
			ref: 'store/main',
			itemId: 'i',
			question: 'q',
			status: 'failed',
			answer: null,
		},
		{
			type: 'session_ask_requested',
			ref: 'store/main',
			id: 'r1',
			kind: 'ask',
			session: 'checkout',
			text: 'which limit?',
			files: [],
		},
		{
			type: 'session_fork_settled',
			ref: 'store/main',
			id: 'r1',
			status: 'answered',
			answer: 'five',
			files: [],
			read: [],
		},
		{ type: 'secret_transferred', ref: 'store/main', id: 'r1', path: '/s/x' },
		{ type: 'conversation_reset', ref: 'store/main' },
		{ type: 'compacting', ref: 'store/main', isCompacting: true },
		{ type: 'session_notice', ref: 'store/main', text: 'n' },
		{
			type: 'mode_refused',
			ref: 'store/main',
			mode: 'bypassPermissions',
			kept: 'auto',
			reason: 'root',
		},
	];

	it('covers every report a remote may make', () => {
		expect(new Set(samples.map((sample) => sample.type))).toEqual(REMOTE_OBSERVATIONS);
	});

	it.each(samples.map((sample) => [sample.type, sample] as const))(
		'%s → every ref and ask id prefixed',
		(_type, sample) => {
			const mapped = toMainInput('vm1', sample);
			const text = JSON.stringify(mapped);

			expect(mapped).not.toBeNull();
			expect(text).toMatch(/"vm1:(?:store\/main|ask-store\/main-1)"/);
			expect(text).not.toContain('"store/main"');
			expect(text).not.toContain('"ask-store/main-1"');
		},
	);

	it('a report only the main makes → dropped', () => {
		expect(
			toMainInput('vm1', { type: 'limits', limits: { fiveHour: 1, sevenDay: 1, resetsAt: null } }),
		).toBeNull();
	});
});
