import { englishJudge } from '../../test/support/english-judge.js';
import { describe, expect, it } from 'bun:test';
import type { Action, Machine, State } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { createNullNotes } from '../../test/support/notes.js';
import { executeTool, type ToolContext } from './tools.js';
import { describeToolCall } from './call-lines.js';
import { findSessionsNamedIn } from './session-naming.js';
import { resolveRef } from '../router/refs.js';
import { LOCAL_MACHINE } from '../shared/machine-ref.js';

interface CreateContextParams {
	patch?: Partial<State>;
	screen?: string | null;
	utterance?: string;
}

const PERSONAL: Machine = {
	id: 'personal',
	host: 'dev@personal',
	name: 'Personal',
	status: 'connected',
	detail: null,
	since: 0,
};

const createContext = ({ patch = {}, screen = null, utterance }: CreateContextParams = {}) => {
	const refs = ['crew/main', 'store-front/wrk1', 'personal:crew/main'];
	const state: State = {
		...createInitialState(),
		sessions: Object.fromEntries(
			refs.map((ref) => [
				ref,
				createSession({
					ref,
					label: ref.replace(/^personal:/, ''),
					branch: '',
					cwd: '/w',
					dirs: [],
					isPinned: false,
				}),
			]),
		),
		order: refs,
		machines: { personal: PERSONAL },
		...patch,
		// Every session active unless the test says which are.
		active: patch.active ?? refs,
	};
	const actions: Action[] = [];
	const tools: ToolContext = {
		getState: () => state,
		dispatch: (action) => actions.push(action),
		readHistory: () => [],
		now: () => 0,
		asks: state.asks,
		mute: () => {},
		saveDebugNote: () => {},
		judge: englishJudge,
		notes: createNullNotes(),
		setListenMode: () => 'changed' as const,
		openUrl: () => true,
		screen,
		utterance,
	};

	return { state, tools, actions };
};

describe('rename_session', () => {
	it('"rename this to voice os dev" on a session → named, with a fixed reply', async () => {
		const { tools, actions } = createContext({ screen: 'crew/main' });

		const result = await executeTool(
			'rename_session',
			{ ref: null, name: ' voice os dev ' },
			tools,
		);

		expect(actions).toEqual([{ type: 'rename_session', ref: 'crew/main', name: 'voice os dev' }]);
		expect(result).toMatchObject({ ok: true, reply: 'Renamed crew, main to voice os dev.' });
		expect(result.recordAs).toEqual({
			name: 'rename_session',
			input: { ref: 'crew/main', name: ' voice os dev ' },
		});
	});

	it("another machine's session named with its machine → that one renamed", async () => {
		const { tools, actions } = createContext({
			utterance: 'call crew main on Personal voice os dev',
		});

		await executeTool('rename_session', { ref: 'crew/main', name: 'voice os dev' }, tools);

		expect(actions).toEqual([
			{ type: 'rename_session', ref: 'personal:crew/main', name: 'voice os dev' },
		]);
	});

	it('an empty name → cleared, the crew name said', async () => {
		const { tools, actions } = createContext({
			screen: 'crew/main',
			patch: { names: { 'crew/main': 'voice os dev' } },
		});

		const result = await executeTool('rename_session', { ref: null, name: '' }, tools);

		expect(actions).toEqual([{ type: 'rename_session', ref: 'crew/main', name: '' }]);
		expect(result.reply).toBe('Cleared the name of crew, main.');
	});

	it('an empty name for a session with no name → fails, nothing dispatched', async () => {
		const { tools, actions } = createContext({ screen: 'crew/main' });

		expect(await executeTool('rename_session', { ref: null, name: '' }, tools)).toEqual({
			ok: false,
			content: 'crew, main has no name to clear',
		});
		expect(actions).toEqual([]);
	});

	it('a name another session has → fails, nothing dispatched', async () => {
		const { tools, actions } = createContext({
			patch: { names: { 'store-front/wrk1': 'Voice OS dev' } },
		});

		const result = await executeTool(
			'rename_session',
			{ ref: 'crew/main', name: 'voice-os dev' },
			tools,
		);

		expect(result).toEqual({
			ok: false,
			content:
				'"voice-os dev" already names store-front/wrk1: ask for another name, or clear that one first (rename_session ref "voice-os dev", name "")',
		});
		expect(actions).toEqual([]);
	});

	it('no session on screen and no ref → fails, nothing dispatched', async () => {
		const { tools, actions } = createContext();

		expect(await executeTool('rename_session', { ref: null, name: 'api work' }, tools)).toEqual({
			ok: false,
			content: 'no session on screen: name one',
		});
		expect(actions).toEqual([]);
	});

	it('the name it already has → the reply, no dispatch', async () => {
		const { tools, actions } = createContext({ patch: { names: { 'crew/main': 'api work' } } });

		const result = await executeTool(
			'rename_session',
			{ ref: 'crew/main', name: 'api work' },
			tools,
		);

		expect(result).toMatchObject({ ok: true, reply: 'Already named api work.' });
		expect(actions).toEqual([]);
	});

	it('"clear the name ghost" for a session that is gone → cleared by the name', async () => {
		const { tools, actions } = createContext({ patch: { names: { 'crew/wrk9': 'ghost' } } });

		const result = await executeTool('rename_session', { ref: 'ghost', name: '' }, tools);

		expect(actions).toEqual([{ type: 'rename_session', ref: 'crew/wrk9', name: '' }]);
		expect(result).toMatchObject({ ok: true, reply: 'Cleared the name of crew, work 9.' });
	});

	it('"rename ghost to spirit" for a session that is gone → renamed by the name', async () => {
		const { tools, actions } = createContext({ patch: { names: { 'crew/wrk9': 'ghost' } } });

		const result = await executeTool('rename_session', { ref: 'ghost', name: 'spirit' }, tools);

		expect(actions).toEqual([{ type: 'rename_session', ref: 'crew/wrk9', name: 'spirit' }]);
		expect(result).toMatchObject({ ok: true, reply: 'Renamed ghost to spirit.' });
	});

	it('describeToolCall → the new name, or cleared', () => {
		expect(
			describeToolCall({
				name: 'rename_session',
				input: { ref: 'crew/main', name: 'voice os dev' },
				ok: true,
			}),
		).toBe('rename_session crew/main to "voice os dev"');
		expect(
			describeToolCall({ name: 'rename_session', input: { ref: 'crew/main', name: '' }, ok: true }),
		).toBe('rename_session crew/main cleared');
	});
});

describe('findSessionsNamedIn with display names', () => {
	it('the display name said → that session; the crew words still work', () => {
		const { state } = createContext({ patch: { names: { 'store-front/wrk1': 'Voice-OS dev' } } });

		expect(findSessionsNamedIn(state, 'go to voice os dev.')).toEqual(['store-front/wrk1']);
		expect(findSessionsNamedIn(state, 'go to store front work one')).toEqual(['store-front/wrk1']);
	});

	it("a name on another machine's crew/main, this Mac's crew/main on screen → the name reaches the named one", () => {
		const { state } = createContext({
			patch: {
				names: { 'personal:crew/main': 'voice os dev' },
				view: { kind: 'grid', machine: LOCAL_MACHINE },
			},
		});

		expect(resolveRef(state, 'voice os dev')).toBe('personal:crew/main');
		expect(findSessionsNamedIn(state, 'go to voice os dev')).toEqual(['personal:crew/main']);
		expect(resolveRef(state, 'crew main')).toBe('crew/main');
	});

	it("an inactive session's name → not found among the active ones; found among every session", () => {
		const { state } = createContext({
			patch: { names: { 'store-front/wrk1': 'voice os dev' }, active: ['crew/main'] },
		});

		expect(findSessionsNamedIn(state, 'go to voice os dev')).toEqual([]);
		expect(findSessionsNamedIn(state, 'go to voice os dev', state.order)).toEqual([
			'store-front/wrk1',
		]);
	});

	it('a name only inside another word → nothing', () => {
		const { state } = createContext({ patch: { names: { 'store-front/wrk1': 'dev' } } });

		expect(findSessionsNamedIn(state, 'ask the devops folks')).toEqual([]);
	});
});

describe('a name that is also a command', () => {
	it('"back" → renamed, with a warning that it may be heard as the command', async () => {
		const { tools } = createContext({ utterance: 'call store front work one back' });
		const result = await executeTool(
			'rename_session',
			{ ref: 'store-front/wrk1', name: 'back' },
			tools,
		);

		expect(result.reply).toContain('Heads up: "back" is also something you say to Voice OS');
	});
});
