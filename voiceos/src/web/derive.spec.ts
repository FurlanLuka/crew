import { describe, expect, it } from 'bun:test';
import type {
	Machine,
	MachineStatus,
	MeanwhileItem,
	PendingAsk,
	Session,
	State,
} from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { GENERAL_NOTES } from '../shared/notes.js';
import { findCurrentAsk, describeRouteChip } from '../shared/route-chip.js';
import { isRemembered, VOICE_MEMORY_MS } from '../shared/protocol.js';

import {
	countActive,
	countSessions,
	countUpdates,
	describeActiveCard,
	labelAcrossMachines,
	readRefTitle,
	describeMissingActive,
	formatDidLine,
	listActiveTiles,
	listTabRefs,
	readNotesFor,
	listOtherSessions,
	readLastLine,
	describeSessionBadge,
	classifyDiffLine,
	listDocs,
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
	it('setup session idle → setup badge', () =>
		expect(
			describeSessionBadge(createTestSession({ isPinned: true, status: 'idle' }), []).dot,
		).toBe('setup'));
	it('compacting → compacting, even while running', () =>
		expect(
			describeSessionBadge(createTestSession({ status: 'running', compactingSince: 1 }), []).label,
		).toBe('compacting'));
	it('turn over, background sub-agents still working → sub-agents, not idle', () =>
		expect(
			describeSessionBadge(
				createTestSession({
					status: 'idle',
					subagents: [
						{
							taskId: 't',
							agentType: null,
							description: 'research',
							startedAt: 0,
							step: null,
							isBackground: true,
						},
					],
				}),
				[],
			),
		).toEqual({ dot: 'running', label: 'sub-agents', isAlarm: false }));
	it('stopped after a crash → crashed', () =>
		expect(
			describeSessionBadge(createTestSession({ status: 'stopped', error: 'boom' }), []).label,
		).toBe('crashed'));
	it('a held /clear → confirm', () =>
		expect(
			describeSessionBadge(createTestSession({ status: 'idle' }), [
				{ id: 'c', ref: 'store/main', at: 1, kind: 'command', command: 'clear', text: '/clear' },
			]),
		).toEqual({ dot: 'needs', label: 'confirm', isAlarm: true }));
	it('a held switch → confirm', () =>
		expect(
			describeSessionBadge(createTestSession({ status: 'running' }), [
				{ id: 'r', ref: 'store/main', at: 1, kind: 'redirect', text: 'fix login', target: 's1' },
			]),
		).toEqual({ dot: 'needs', label: 'confirm', isAlarm: true }));
	it('another session’s ask does not flag this one', () =>
		expect(
			describeSessionBadge(createTestSession({ status: 'idle' }), [createTestAsk('a', 'other/x')])
				.isAlarm,
		).toBe(false));
});

// Inactive, and labelled by crew: what a tile shows when nothing else decides it.
const lastLineOf = (session: Session): string => readLastLine(session, session.label, false);

describe('readLastLine', () => {
	it('an approval last → what was allowed, not "you:"', () =>
		expect(
			lastLineOf(
				createTestSession({
					stream: [
						{
							id: 'u',
							at: 1,
							kind: 'user',
							text: 'The user allows this once: retry "run git push" now.',
							isApproval: true,
						},
					],
				}),
			),
		).toBe('allowed once: run git push'));

	it('streaming draft wins', () =>
		expect(lastLineOf(createTestSession({ draft: 'Typing…' }))).toBe('Typing…'));

	it('a draft shows without its spoken line, closed or still streaming', () => {
		expect(lastLineOf(createTestSession({ draft: '<spoken>Tests pass.</spoken>\nAll 40' }))).toBe(
			'All 40',
		);
		expect(
			lastLineOf(
				createTestSession({
					draft: '<spoken>Tests pa',
					stream: [{ id: 't', at: 1, kind: 'text', text: 'Earlier reply.' }],
				}),
			),
		).toBe('Earlier reply.');
	});
	it('a Markdown reply → its words, without the signs', () =>
		expect(
			lastLineOf(
				createTestSession({
					stream: [{ id: 't', at: 1, kind: 'text', text: '## Done\n**Tests pass.**' }],
				}),
			),
		).toBe('Done\nTests pass.'));
	it('never started → activate hint names the session', () =>
		expect(lastLineOf(createTestSession())).toContain('activate store/main'));
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
	it("viewing a session → never another session's ask", () => {
		const state: State = {
			...createInitialState(),
			view: { kind: 'session', ref: 'b/x' },
			asks: [createTestAsk('1', 'a/x')],
		};
		expect(findCurrentAsk(state)).toBeNull();
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

const createTestMachine = (status: MachineStatus): Machine => ({
	id: 'vm1',
	host: 'vm1',
	name: 'Build box',
	status,
	detail: null,
	since: 1,
});

const createActiveState = (patch: Partial<State> = {}): State => ({
	...createInitialState(),
	machines: { vm1: createTestMachine('connected') },
	sessions: {
		'store/main': createTestSession({ status: 'running' }),
		'store/wrk1': createTestSession({ ref: 'store/wrk1', label: 'store/wrk1' }),
		'vm1:api/main': createTestSession({ ref: 'vm1:api/main', label: 'api/main' }),
	},
	order: ['store/main', 'store/wrk1', 'vm1:api/main'],
	active: ['vm1:api/main', 'store/main'],
	...patch,
});

describe('countActive', () => {
	it('a remote active session and a local one, one waiting → both counted, only the active ones', () =>
		expect(countActive(createActiveState({ asks: [createTestAsk('1', 'vm1:api/main')] }))).toEqual({
			total: 2,
			running: 1,
			waiting: 1,
		}));
	it('an active ref with no session → not counted', () =>
		expect(countActive(createActiveState({ active: ['store/main', 'gone/main'] }))).toEqual({
			total: 1,
			running: 1,
			waiting: 0,
		}));
});

describe('countUpdates', () => {
	const update = (ref: string): MeanwhileItem => ({ ref, kind: 'done', about: null, at: 1 });
	// Every session has an update; the active ones are vm1:api/main and store/main.
	const createUpdatesState = (patch: Partial<State> = {}): State =>
		createActiveState({
			meanwhile: [update('store/main'), update('store/wrk1'), update('vm1:api/main')],
			...patch,
		});
	const waitingOn = (...refs: string[]): Partial<State> => ({
		asks: refs.map((ref, index) => createTestAsk(String(index), ref)),
	});

	it.each([
		['no overlap: none waiting on you', 3, {}, {}],
		['every update also waiting', 0, waitingOn('store/main', 'store/wrk1', 'vm1:api/main'), {}],
		['partial overlap', 2, waitingOn('vm1:api/main'), {}],
		['this Mac only', 2, waitingOn('vm1:api/main'), { machine: 'local' }],
		['a remote machine, its update waiting', 0, waitingOn('vm1:api/main'), { machine: 'vm1' }],
		['a remote machine, waiting elsewhere', 1, waitingOn('store/main'), { machine: 'vm1' }],
		['the active set', 2, {}, 'active'],
		['the active set, one waiting', 1, waitingOn('vm1:api/main'), 'active'],
		['the active set, waiting off it', 2, waitingOn('store/wrk1'), 'active'],
	] as const)('%s → %d', (_name, expected, patch, scope) =>
		expect(countUpdates(createUpdatesState(patch), scope)).toBe(expected),
	);
});

describe('describeMissingActive', () => {
	it('its machine out of reach → "<label> · <machine> out of reach"', () =>
		expect(
			describeMissingActive(
				createActiveState({ machines: { vm1: createTestMachine('unreachable') } }),
				'vm1:api/wrk2',
			),
		).toBe('api/wrk2 · Build box out of reach'));
	it('its machine connected, the session gone → "· gone" with the machine', () =>
		expect(describeMissingActive(createActiveState(), 'vm1:api/wrk2')).toBe(
			'Build box · api/wrk2 · gone',
		));
	it('a local active ref gone → "<label> · gone"', () =>
		expect(describeMissingActive(createActiveState(), 'store/wrk9')).toBe('store/wrk9 · gone'));
	it('a named active ref gone → its name, not the crew ref', () =>
		expect(
			describeMissingActive(createActiveState({ names: { 'store/wrk9': 'ghost' } }), 'store/wrk9'),
		).toBe('ghost · gone'));
});

describe('listActiveTiles', () => {
	const readTiles = (state: State): string[] =>
		listActiveTiles(state).map((tile) => ('session' in tile ? tile.session.ref : tile.missing));

	const withSetup = (patch: Partial<State>): State => {
		const state = createActiveState(patch);

		return {
			...state,
			sessions: {
				...state.sessions,
				setup: createTestSession({ ref: 'setup', label: 'setup', isPinned: true }),
			},
			order: ['setup', ...state.order],
		};
	};

	it('active refs in the order activated → a session each, the gone ones as placeholders after', () =>
		expect(readTiles(createActiveState({ active: ['store/gone', 'vm1:api/main'] }))).toEqual([
			'vm1:api/main',
			'store/gone · gone',
		]));
	it("this Mac's setup → first, though it is never in the set", () =>
		expect(readTiles(withSetup({ active: ['vm1:api/main', 'store/main'] }))).toEqual([
			'setup',
			'vm1:api/main',
			'store/main',
		]));
	it('nothing activated → the setup session alone', () =>
		expect(readTiles(withSetup({ active: [] }))).toEqual(['setup']));
});

describe('listTabRefs', () => {
	it('on Active → the active sessions that are here, in the order activated', () =>
		expect(
			listTabRefs(
				createActiveState({
					view: { kind: 'active' },
					active: ['vm1:api/main', 'x/gone', 'store/main'],
				}),
			),
		).toEqual(['vm1:api/main', 'store/main']));
	it('on a session opened from Active → the active sessions', () =>
		expect(
			listTabRefs(
				createActiveState({ view: { kind: 'session', ref: 'store/main', from: 'active' } }),
			),
		).toEqual(['vm1:api/main', 'store/main']));
	it("on a session without from → its machine's sessions", () =>
		expect(
			listTabRefs(createActiveState({ view: { kind: 'session', ref: 'store/main' } })),
		).toEqual(['store/main', 'store/wrk1']));
	it("on a machine's grid → that machine's sessions", () =>
		expect(listTabRefs(createActiveState({ view: { kind: 'grid', machine: 'vm1' } }))).toEqual([
			'vm1:api/main',
		]));
});

describe('named sessions', () => {
	const named = createActiveState({ names: { 'vm1:api/main': 'voice os dev' } });

	it("another machine's session, named → the name alone, no machine prefix", () =>
		expect(labelAcrossMachines(named, 'vm1:api/main', null)).toBe('voice os dev'));
	it("another machine's session, unnamed → its machine's name before crew's label", () =>
		expect(labelAcrossMachines(createActiveState(), 'vm1:api/main', null)).toBe(
			'Build box · api/main',
		));
	it('a named session → the crew ref on hover; an unnamed one → none', () => {
		expect(readRefTitle(named, 'vm1:api/main')).toBe('vm1:api/main');
		expect(readRefTitle(named, 'store/main')).toBeUndefined();
	});
	it('a named active session waiting → the Active card says it by its name', () =>
		expect(
			describeActiveCard({ ...named, asks: [createTestAsk('1', 'vm1:api/main')] }).waiting,
		).toBe('voice os dev: wants to run x'));
	it('an unnamed remote active session waiting → the Active card names its machine', () =>
		expect(
			describeActiveCard(createActiveState({ asks: [createTestAsk('1', 'vm1:api/main')] })).waiting,
		).toBe('Build box · api/main: wants to run x'));
	it('an active session stopped (a crash, its machine away) → only "Not running."', () =>
		expect(readLastLine(createTestSession({ status: 'stopped' }), 'voice os dev', true)).toBe(
			'Not running.',
		));
	it('a stopped named session → its last line says to activate it by its name', () =>
		expect(readLastLine(createTestSession({ status: 'stopped' }), 'voice os dev', false)).toBe(
			'Not running. Activate it, or say “activate voice os dev”.',
		));
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
		['switch_view active', 'went to Active'],
		['activate vm1:store/main', 'activated vm1:store/main'],
		['deactivate store/main', 'deactivated store/main'],
		['deactivate', 'deactivated this session'],
		['answer yes store/main', 'answered yes store/main'],
		['dev_offer accepted', 'accepted the fix offer'],
		['dev_offer declined', 'declined the fix offer'],
		['mute', 'went quiet'],
		['hands_free push', 'listening: push'],
		['debug_note "it re-asked"', 'noted for debugging "it re-asked"'],
		['note "try a tone"', 'noted "try a tone"'],
		['deactivate store/main (failed)', 'deactivated store/main — failed'],
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
		active: ['store/main', 'store/wrk1'],
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
		active: ['store/main', 'store/wrk1'],
		view: { kind: 'session', ref: 'store/main' },
	});

	it('another session waits, typing here → this session (the router sends it here)', () =>
		expect(
			describeRouteChip(
				{ ...createBaseState(), asks: [createTestAsk('p', 'store/wrk1')] },
				{ draft: 'run the tests' },
			).label,
		).toBe('→ store/main'));
	it('same, nothing typed → Voice OS: that ask waits for a switch there', () =>
		expect(
			describeRouteChip({ ...createBaseState(), asks: [createTestAsk('p', 'store/wrk1')] }).label,
		).toBe('→ Voice OS'));
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
			{ name: 'deactivate', input: { ref: 'store/main' }, ok: false },
			'deactivated store/main — failed',
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

describe('readNotesFor', () => {
	it('the workspace on screen, newest first, the state left as it was; Mission Control → general', () => {
		const state: State = {
			...createInitialState(),
			notes: { store: ['- a', '- b'], [GENERAL_NOTES]: ['- loose'] },
		};

		expect(readNotesFor(state, 'store/main')).toEqual(['- b', '- a']);
		expect(state.notes.store).toEqual(['- a', '- b']);
		expect(readNotesFor(state, null)).toEqual(['- loose']);
		expect(readNotesFor(state, 'checkout/main')).toEqual([]);
	});
});

describe('listDocs', () => {
	it('newest first, each doc once', () => {
		const stream = [
			{ id: 'a', at: 1, kind: 'doc' as const, url: 'https://claude.ai/a', title: 'A' },
			{ id: 'b', at: 2, kind: 'doc' as const, url: 'https://claude.ai/b', title: 'B' },
			{ id: 'c', at: 3, kind: 'doc' as const, url: 'https://claude.ai/a', title: 'A' },
		];

		expect(listDocs({ stream })).toEqual([
			{ url: 'https://claude.ai/a', title: 'A' },
			{ url: 'https://claude.ai/b', title: 'B' },
		]);
	});
});
