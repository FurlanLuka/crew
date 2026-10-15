import { describe, expect, it } from 'bun:test';
import type { Session, StreamItem } from '../shared/protocol.js';
import { createSession } from '../state/reducer.js';
import { readWorkingLine } from './working-line.js';

const tool = (summary: string): StreamItem => ({
	id: summary,
	at: 1,
	kind: 'tool',
	name: 'Bash',
	summary,
});
const result: StreamItem = { id: 'r', at: 2, kind: 'tool_result', ok: true, summary: '' };

const session = (patch: Partial<Session>): Session => ({
	...createSession({
		ref: 'store/main',
		label: 'store/main',
		branch: '',
		cwd: '/w',
		dirs: [],
		isPinned: false,
	}),
	status: 'running',
	requests: [{ text: 'fix it', at: 1000 }],
	...patch,
});

describe('readWorkingLine', () => {
	it('running, nothing yet → thinking, since the request', () =>
		expect(readWorkingLine(session({}), false)).toEqual({
			kind: 'working',
			what: 'Thinking',
			since: 1000,
		}));

	it('a tool with no result yet → that tool, said as happening', () => {
		expect(
			readWorkingLine(session({ stream: [tool('run pnpm test --filter checkout')] }), false),
		).toMatchObject({ what: 'Running pnpm test --filter checkout' });
		expect(readWorkingLine(session({ stream: [tool('read src/app.ts')] }), false)).toMatchObject({
			what: 'Read src/app.ts',
		});
	});

	it('the tool came back → thinking again; text arriving → writing', () => {
		expect(readWorkingLine(session({ stream: [tool('run ls'), result] }), false)).toMatchObject({
			what: 'Thinking',
		});
		expect(readWorkingLine(session({ draft: 'Two cases fail' }), false)).toMatchObject({
			what: 'Writing',
		});
	});

	it('blocked, or a question open for it → waiting on you', () => {
		expect(readWorkingLine(session({ status: 'blocked' }), false)).toEqual({ kind: 'waiting' });
		expect(readWorkingLine(session({}), true)).toEqual({ kind: 'waiting' });
	});

	it('idle, stopped or compacting → no line', () => {
		expect(readWorkingLine(session({ status: 'idle' }), false)).toBeNull();
		expect(readWorkingLine(session({ status: 'stopped' }), false)).toBeNull();
		expect(readWorkingLine(session({ compactingSince: 5 }), false)).toBeNull();
	});

	it('a long command is cut', () =>
		expect(
			(
				readWorkingLine(session({ stream: [tool(`run ${'x'.repeat(100)}`)] }), false) as {
					what: string;
				}
			).what.length,
		).toBe('Running '.length + 60));
});
