import { describe, expect, it } from 'bun:test';
import type { Observation } from '../shared/protocol.js';
import { createLineDecoder, encodeLine, parseMainLine, parseRemoteLine } from './protocol.js';

const decodeAll = (chunks: (string | Uint8Array)[]): string[] => {
	const lines: string[] = [];
	const decode = createLineDecoder((line) => lines.push(line));

	for (const chunk of chunks) {
		decode(chunk);
	}

	return lines;
};

describe('createLineDecoder', () => {
	it('two messages in one chunk → two lines', () => {
		expect(decodeAll(['{"type":"pong"}\n{"type":"pong"}\n'])).toEqual([
			'{"type":"pong"}',
			'{"type":"pong"}',
		]);
	});

	it('one message split over chunks → one line, once complete', () => {
		expect(decodeAll(['{"ty', 'pe":"po', 'ng"}\n'])).toEqual(['{"type":"pong"}']);
	});

	it('a character split between chunks → intact', () => {
		const bytes = new TextEncoder().encode('{"x":"é"}\n');

		expect(decodeAll([bytes.slice(0, 7), bytes.slice(7)])).toEqual(['{"x":"é"}']);
	});

	it('an unfinished line → held back', () => {
		expect(decodeAll(['{"type":"pong"}'])).toEqual([]);
	});
});

describe('parseRemoteLine', () => {
	it('a login banner → not a message', () => {
		expect(parseRemoteLine('Welcome to Ubuntu 24.04').ok).toBe(false);
	});

	it('a report a remote may make → accepted', () => {
		const line = encodeLine({
			type: 'input',
			input: { type: 'turn_started', ref: 'store/main' },
		}).trim();

		expect(parseRemoteLine(line)).toEqual({
			ok: true,
			message: { type: 'input', input: { type: 'turn_started', ref: 'store/main' } },
		});
	});

	it("a sub-agent's transcript line, and a start from an older remote without its call's id → accepted", () => {
		for (const input of [
			{
				type: 'subagent_item',
				ref: 'store/main',
				taskId: 't1',
				item: { kind: 'text', text: 'Found it.' },
			},
			{
				type: 'subagent_started',
				ref: 'store/main',
				taskId: 't1',
				agentType: null,
				description: 'd',
				isBackground: false,
			},
		] satisfies Observation[]) {
			expect(parseRemoteLine(encodeLine({ type: 'input', input }).trim())).toEqual({
				ok: true,
				message: { type: 'input', input },
			});
		}
	});

	it('a report only the main makes (limits, narration, its own actions) → refused', () => {
		const limits = JSON.stringify({ type: 'input', input: { type: 'limits', limits: {} } });
		const send = JSON.stringify({ type: 'input', input: { type: 'send', ref: 'a/b', text: 'x' } });

		expect(parseRemoteLine(limits)).toEqual({ ok: false, error: 'a remote may not send limits' });
		expect(parseRemoteLine(send).ok).toBe(false);
	});

	it('a hello round-trips', () => {
		const hello = {
			type: 'hello' as const,
			version: '1.0.0',
			host: 'vm1',
			snapshot: { worktrees: [], sessions: [], asks: [], asides: [] },
		};

		expect(parseRemoteLine(encodeLine(hello).trim())).toEqual({ ok: true, message: hello });
	});

	it("a remote's plain session keeps isChat through the snapshot: without it the main would treat it as a worktree", () => {
		const chat = {
			ref: 'chat/3fa9c1',
			label: 'research',
			branch: '',
			cwd: '/home/dev',
			dirs: [],
			isPinned: false,
			isChat: true as const,
		};
		const hello = {
			type: 'hello' as const,
			version: '1.0.0',
			host: 'vm1',
			snapshot: { worktrees: [chat], sessions: [], asks: [], asides: [] },
		};

		expect(parseRemoteLine(encodeLine(hello).trim())).toEqual({ ok: true, message: hello });
	});
});

describe('parseMainLine', () => {
	it('a hello with pending effects round-trips', () => {
		const hello = {
			type: 'hello' as const,
			version: '1.0.0',
			mainId: 'm',
			runId: 'r',
			pending: [
				{ seq: 3, effect: { type: 'worker_send' as const, ref: 'store/main', text: 'hi' } },
			],
		};

		expect(parseMainLine(encodeLine(hello).trim())).toEqual({ ok: true, message: hello });
	});

	it('an effect with no ref → refused', () => {
		expect(
			parseMainLine(JSON.stringify({ type: 'effect', seq: 1, effect: { type: 'speak' } })).ok,
		).toBe(false);
	});
});

describe('message kinds', () => {
	it.each([
		{
			type: 'refused' as const,
			reason: 'held' as const,
			detail: 'Another Voice OS drives this machine.',
		},
		{
			type: 'refused' as const,
			reason: 'version' as const,
			detail: 'This machine runs Voice OS 5.0.1 and the main 5.1.0: …',
			version: '5.0.1',
		},
		{ type: 'ack' as const, upTo: 4 },
		{ type: 'result' as const, id: 3, ok: false as const, error: 'not allowed' },
		{ type: 'media' as const, name: 'a.png', base64: 'iVBORw0K' },
	])('$type round-trips', (message) => {
		expect(parseRemoteLine(encodeLine(message).trim())).toEqual({ ok: true, message });
	});

	it('a line of megabytes (an image) → one message, whole', () => {
		const base64 = 'A'.repeat(5_000_000);
		const lines: string[] = [];
		const decode = createLineDecoder((line) => lines.push(line));
		const text = encodeLine({ type: 'media', name: 'b.png', base64 });

		for (let at = 0; at < text.length; at += 65_536) {
			decode(text.slice(at, at + 65_536));
		}

		expect(lines).toHaveLength(1);
		expect(parseRemoteLine(lines[0] ?? '')).toMatchObject({ ok: true, message: { base64 } });
	});
});

describe('crew calls, both ways', () => {
	const call = { type: 'call' as const, id: 1, method: 'crew' as const, args: ['voice', 'logs'] };
	const answered = {
		type: 'result' as const,
		id: 1,
		ok: true as const,
		value: { code: 0, stdout: '', stderr: '' },
	};
	const tooManyArgs = { ...call, args: Array.from({ length: 21 }, () => 'x') };
	const noValue = { type: 'result', id: 1, ok: true };

	it('a remote asking the main → its call and the answer read', () => {
		expect(parseRemoteLine(JSON.stringify(call))).toEqual({ ok: true, message: call });
		expect(parseMainLine(JSON.stringify(answered))).toEqual({ ok: true, message: answered });
	});

	it('the main asking a remote → its call and the answer read', () => {
		expect(parseMainLine(JSON.stringify(call))).toEqual({ ok: true, message: call });
		expect(parseRemoteLine(JSON.stringify(answered))).toEqual({ ok: true, message: answered });
	});

	it('past the bounds, or an answer without its output → refused either way', () => {
		expect(parseRemoteLine(JSON.stringify(tooManyArgs)).ok).toBe(false);
		expect(parseMainLine(JSON.stringify(tooManyArgs)).ok).toBe(false);
		expect(parseRemoteLine(JSON.stringify(noValue)).ok).toBe(false);
		expect(parseMainLine(JSON.stringify(noValue)).ok).toBe(false);
	});
});
