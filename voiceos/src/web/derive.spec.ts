import { describe, expect, it } from 'bun:test';
import type { PendingAsk, Session, State } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { findCurrentAsk, describeRouteChip } from '../shared/route-chip.js';
import { isRemembered, VOICE_MEMORY_MS } from '../shared/protocol.js';

import {
	countSessions,
	formatDidLine,
	listOtherSessions,
	readLastLine,
	describeSessionBadge,
	classifyDiffLine,
} from './derive.js';
import { describeToolCall } from '../tools/call-lines.js';

const createTestSession = (patch: Partial<Session> = {}): Session => ({
	...createSession({
		ref: 'store/main',
		label: 'store/main',
		branch: 'b',
		cwd: '/w',
		dirs: [],
		isPinned: false,
	}),
	...patch,
});
const createTestAsk = (
	id: string,
	ref: string,
	kind: 'permission' | 'question' = 'permission',
): PendingAsk =>
	kind === 'permission'
		? { id, ref, at: 1, kind, toolName: 'Bash', summary: 'run x', input: {}, suggestions: [] }
		: { id, ref, at: 1, kind, input: {}, questions: [] };

describe('describeSessionBadge', () => {
	it('pending permission outranks everything → red permission', () =>
		expect(
			describeSessionBadge(
				createTestSession({ status: 'blocked', needsUser: { text: 'x', at: 1 } }),
				[createTestAsk('a', 'store/main')],
			),
		).toEqual({ dot: 'blocked', label: 'permission', isAlarm: true }));
	it('turn ended in a question → asked you', () =>
		expect(
			describeSessionBadge(
				createTestSession({ status: 'idle', needsUser: { text: 'Push?', at: 1 } }),
				[],
			).label,
		).toBe('asked you'));
	it('pinned setup session idle → setup badge', () =>
		expect(
			describeSessionBadge(createTestSession({ isPinned: true, status: 'idle' }), []).dot,
		).toBe('setup'));
	it('stopped after a crash → crashed', () =>
		expect(
			describeSessionBadge(createTestSession({ status: 'stopped', error: 'boom' }), []).label,
		).toBe('crashed'));
	it('another session’s ask does not flag this one', () =>
		expect(
			describeSessionBadge(createTestSession({ status: 'idle' }), [createTestAsk('a', 'other/x')])
				.isAlarm,
		).toBe(false));
});

describe('readLastLine', () => {
	it('streaming draft wins', () =>
		expect(readLastLine(createTestSession({ draft: 'Typing…' }))).toBe('Typing…'));
	it('never started → start hint names the session', () =>
		expect(readLastLine(createTestSession())).toContain('start store/main'));
});

describe('findCurrentAsk', () => {
	it('viewing a session → its ask first even if another is older', () => {
		const state: State = {
			...createInitialState(),
			view: { kind: 'session', ref: 'b/x' },
			asks: [createTestAsk('1', 'a/x'), createTestAsk('2', 'b/x')],
		};
		expect(findCurrentAsk(state)?.id).toBe('2');
	});
	it('grid → oldest ask anywhere', () => {
		expect(
			findCurrentAsk({
				...createInitialState(),
				asks: [createTestAsk('1', 'a/x'), createTestAsk('2', 'b/x')],
			})?.id,
		).toBe('1');
	});
});

describe('countSessions', () => {
	it('waiting counts sessions, not asks', () => {
		const state: State = {
			...createInitialState(),
			sessions: {
				'store/main': createTestSession({ status: 'blocked' }),
				'store/wrk1': { ...createTestSession({ ref: 'store/wrk1', status: 'running' }) },
			},
			asks: [createTestAsk('1', 'store/main'), createTestAsk('2', 'store/main', 'question')],
		};
		expect(countSessions(state)).toEqual({ total: 2, running: 1, waiting: 1 });
	});
});

describe('classifyDiffLine', () => {
	it('classifies hunk header, add, delete, context', () =>
		expect(['@@ -1 +1 @@', '+a', '-b', ' c'].map(classifyDiffLine)).toEqual([
			'h',
			'add',
			'del',
			'ctx',
		]));
});

describe('formatDidLine', () => {
	it.each([
		['forward store/main: run the tests', 'forwarded store/main: run the tests'],
		['switch_view mission control', 'went to Mission Control'],
		['switch_view store/wrk1', 'opened store/wrk1'],
		['answer yes store/main', 'answered yes store/main'],
		['dev_offer accepted', 'accepted the fix offer'],
		['dev_offer declined', 'declined the fix offer'],
		['mute', 'went quiet'],
		['debug_note "it re-asked"', 'noted for debugging "it re-asked"'],
		['stop_session store/main (failed)', 'ended store/main — failed'],
		['something_new x', 'something_new x'],
	])('%p → %p', (did, text) => expect(formatDidLine(did)).toBe(text));
});

describe('listOtherSessions', () => {
	const createState = (): State => {
		const initialState = createInitialState();
		const main = createTestSession({ ref: 'store/main', label: 'store/main' });
		const wrk1 = createTestSession({
			ref: 'store/wrk1',
			label: 'store/wrk1',
			status: 'running',
			requests: [{ text: 'set up wrk3', at: 0 }],
		});
		const wrk2 = createTestSession({
			ref: 'store/wrk2',
			label: 'store/wrk2',
			status: 'idle',
			needsUser: { text: 'asks: push it?', at: 60_000 },
		});
		const wrk3 = createTestSession({ ref: 'store/wrk3', label: 'store/wrk3', status: 'idle' });

		return {
			...initialState,
			sessions: { 'store/main': main, 'store/wrk1': wrk1, 'store/wrk2': wrk2, 'store/wrk3': wrk3 },
			order: ['store/main', 'store/wrk1', 'store/wrk2', 'store/wrk3'],
		};
	};

	it('waiting sessions first with what they ask, then working ones with their task; idle and the screen itself left out', () =>
		expect(listOtherSessions(createState(), 'store/main', 180_000)).toEqual([
			{
				ref: 'store/wrk2',
				label: 'store/wrk2',
				isWaiting: true,
				text: 'asks: push it?',
				age: '2m',
			},
			{ ref: 'store/wrk1', label: 'store/wrk1', isWaiting: false, text: 'set up wrk3', age: '3m' },
		]));

	it('a pending ask is described by its kind', () => {
		const withAsk = { ...createState(), asks: [createTestAsk('p1', 'store/wrk3')] };
		expect(
			listOtherSessions(withAsk, 'store/main', 0).find((row) => row.ref === 'store/wrk3'),
		).toMatchObject({
			isWaiting: true,
			text: 'wants to run x',
		});
	});
});

describe('describeRouteChip', () => {
	const showScreen = (state: State, ref: string | null): State => ({
		...state,
		view: ref ? { kind: 'session', ref } : { kind: 'grid' },
	});
	const createBaseState = (): State => ({
		...createInitialState(),
		sessions: {
			'store/main': createTestSession(),
			'store/wrk1': createTestSession({ ref: 'store/wrk1', label: 'store/wrk1' }),
		},
		order: ['store/main', 'store/wrk1'],
	});

	it('nothing pending → Voice OS decides, spoken or typed on the grid', () => {
		expect(describeRouteChip(showScreen(createBaseState(), null))).toEqual({
			label: '→ Voice OS',
			isAnswering: false,
			isForKernel: true,
		});
		expect(describeRouteChip(showScreen(createBaseState(), 'store/main'))).toEqual({
			label: '→ Voice OS',
			isAnswering: false,
			isForKernel: true,
		});
		expect(
			describeRouteChip(showScreen(createBaseState(), null), { draft: 'run the tests' })
				.isForKernel,
		).toBe(true);
	});
	it("typed into a session's own box → that session; addressed to another → Voice OS decides", () => {
		expect(
			describeRouteChip(showScreen(createBaseState(), 'store/main'), { draft: 'run the tests' })
				.label,
		).toBe('→ store/main');
		expect(
			describeRouteChip(showScreen(createBaseState(), 'store/main'), {
				draft: 'store/wrk1, run the tests',
			}).label,
		).toBe('→ Voice OS');
		expect(
			describeRouteChip(showScreen(createBaseState(), 'store/main'), {
				draft: 'store/main, run the tests',
			}).label,
		).toBe('→ store/main');
		expect(
			describeRouteChip(showScreen(createBaseState(), 'store/main'), {
				draft: 'well, run the tests',
			}).label,
		).toBe('→ store/main');
	});
	it("an ask is pending → answering it, the screen's own first", () => {
		const withAsks = {
			...showScreen(createBaseState(), 'store/main'),
			asks: [createTestAsk('a', 'store/wrk1'), createTestAsk('b', 'store/main')],
		};
		expect(describeRouteChip(withAsks).label).toBe('answering store/main');
		expect(describeRouteChip(showScreen(withAsks, null)).label).toBe('answering store/wrk1');
	});
});

describe("routeChip: typing beats another session's ask", () => {
	const createBaseState = (): State => ({
		...createInitialState(),
		sessions: {
			'store/main': createTestSession(),
			'store/wrk1': createTestSession({ ref: 'store/wrk1', label: 'store/wrk1' }),
		},
		order: ['store/main', 'store/wrk1'],
		view: { kind: 'session', ref: 'store/main' },
	});

	it('another session waits, typing here → this session (the router sends it here)', () =>
		expect(
			describeRouteChip(
				{ ...createBaseState(), asks: [createTestAsk('p', 'store/wrk1')] },
				{ draft: 'run the tests' },
			).label,
		).toBe('→ store/main'));
	it('same, nothing typed → answering it', () =>
		expect(
			describeRouteChip({ ...createBaseState(), asks: [createTestAsk('p', 'store/wrk1')] }).label,
		).toBe('answering store/wrk1'));
	it('this session waits, typing "yes" → answering it', () =>
		expect(
			describeRouteChip(
				{ ...createBaseState(), asks: [createTestAsk('p', 'store/main')] },
				{ draft: 'yes' },
			).label,
		).toBe('answering store/main'));
});

describe('formatDidLine reads what describeToolCall writes', () => {
	it.each([
		[
			{
				name: 'answer',
				input: { ref: 'store/main', decision: 'no', text: 'use a branch' },
				ok: true,
			},
			'answered no store/main "use a branch"',
		],
		[{ name: 'interrupt', input: { ref: 'store/main' }, ok: true }, "stopped store/main's turn"],
		[
			{ name: 'crew_dev', input: { ref: 'store/main', action: 'restart' }, ok: true },
			'dev servers: restart store/main',
		],
		[
			{ name: 'forward', input: { text: 'Run the tests.' }, ok: true },
			'forwarded "Run the tests."',
		],
		[{ name: 'dev_offer', input: { accept: false }, ok: true }, 'declined the fix offer'],
		[
			{ name: 'debug_note', input: { text: 'it re-asked' }, ok: true },
			'noted for debugging "it re-asked"',
		],
		[
			{ name: 'stop_session', input: { ref: 'store/main' }, ok: false },
			'ended store/main — failed',
		],
	])('%j → %p', (call, text) => expect(formatDidLine(describeToolCall(call) ?? '')).toBe(text));
});

describe('isRemembered', () => {
	const now = 10 * VOICE_MEMORY_MS;
	const createEntry = (ago: number, isIgnored = false) => ({
		utterance: 'x',
		did: [],
		reply: '',
		at: now - ago,
		...(isIgnored ? { isIgnored: true as const } : {}),
	});
	it('fresh → remembered', () => expect(isRemembered(createEntry(0), now)).toBe(true));
	it('exactly 30 minutes → remembered; a millisecond more → not', () => {
		expect(isRemembered(createEntry(VOICE_MEMORY_MS), now)).toBe(true);
		expect(isRemembered(createEntry(VOICE_MEMORY_MS + 1), now)).toBe(false);
	});
	it('words the kernel ignored are never remembered', () =>
		expect(isRemembered(createEntry(0, true), now)).toBe(false));
});
