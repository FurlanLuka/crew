import { describe, expect, it } from 'bun:test';
import type { Session, StreamItem } from '../shared/protocol.js';
import { createSession } from '../state/reducer.js';
import { readWorkingState } from './working-line.js';

const tool = (id: string, at: number): StreamItem => ({
	id,
	at,
	kind: 'tool',
	name: 'Bash',
	summary: 'run pnpm test',
});
const result: StreamItem = { id: 'r', at: 9, kind: 'tool_result', ok: true, summary: '' };

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

describe('readWorkingState', () => {
	it('running, nothing yet → thinking, since the request', () =>
		expect(readWorkingState(session({}), false)).toEqual({ kind: 'thinking', since: 1000 }));

	it('a tool with no result yet → that tool, since it started: shown on its own line', () =>
		expect(readWorkingState(session({ stream: [tool('t1', 2000)] }), false)).toEqual({
			kind: 'tool',
			itemId: 't1',
			since: 2000,
		}));

	it('the tool came back → thinking again', () =>
		expect(readWorkingState(session({ stream: [tool('t1', 2000), result] }), false)).toMatchObject({
			kind: 'thinking',
		}));

	it('a reply arriving → nothing more: its caret says it', () =>
		expect(readWorkingState(session({ draft: 'Two cases fail' }), false)).toBeNull());

	it('blocked, or a question open for it → waiting on you', () => {
		expect(readWorkingState(session({ status: 'blocked' }), false)).toEqual({ kind: 'waiting' });
		expect(readWorkingState(session({}), true)).toEqual({ kind: 'waiting' });
	});

	it('idle, stopped or compacting → nothing', () => {
		expect(readWorkingState(session({ status: 'idle' }), false)).toBeNull();
		expect(readWorkingState(session({ status: 'stopped' }), false)).toBeNull();
		expect(readWorkingState(session({ compactingSince: 5 }), false)).toBeNull();
	});
});
