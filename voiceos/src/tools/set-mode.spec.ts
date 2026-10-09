import { describe, expect, it } from 'bun:test';
import type { Action, State } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { englishJudge } from '../../test/support/english-judge.js';
import { createNullNotes } from '../../test/support/notes.js';
import { executeTool, type ToolContext } from './tools.js';

const REFS = ['setup', 'store-front/main', 'checkout-api/main'];

const createState = (patch: Partial<State> = {}): State => ({
	...createInitialState(),
	sessions: Object.fromEntries(
		REFS.map((ref) => [
			ref,
			{
				...createSession({
					ref,
					label: ref,
					branch: '',
					cwd: '/w',
					dirs: [],
					isPinned: ref === 'setup',
				}),
				status: 'idle' as const,
			},
		]),
	),
	order: REFS,
	active: ['store-front/main', 'checkout-api/main'],
	...patch,
});

interface CreateContextParams {
	patch?: Partial<State>;
	screen?: string | null;
}

const createContext = ({ patch = {}, screen = 'store-front/main' }: CreateContextParams = {}) => {
	const state = createState({
		...(screen ? { view: { kind: 'session', ref: screen } } : {}),
		...patch,
	});
	const actions: Action[] = [];
	const tools: ToolContext = {
		getState: () => state,
		dispatch: (action) => actions.push(action),
		readHistory: () => [],
		now: () => 1000,
		asks: state.asks,
		mute: () => {},
		saveDebugNote: () => {},
		judge: englishJudge,
		notes: createNullNotes(),
		setListenMode: () => 'changed' as const,
		openUrl: () => true,
		screen,
		utterance: 'switch to plan mode',
	};

	return { tools, actions };
};

describe('set_mode', () => {
	it('the session on screen → switched, "Plan mode." said', async () => {
		const { tools, actions } = createContext();
		const result = await executeTool('set_mode', { ref: null, mode: 'plan' }, tools);

		expect(actions).toEqual([
			{ type: 'set_mode', ref: 'store-front/main', mode: 'plan', by: 'voice' },
		]);
		expect(result).toMatchObject({ ok: true, reply: 'Plan mode.' });
	});

	it('another session named → switched, said by its name', async () => {
		const { tools, actions } = createContext();
		const result = await executeTool('set_mode', { ref: 'checkout-api/main', mode: 'ask' }, tools);

		expect(actions).toEqual([
			{ type: 'set_mode', ref: 'checkout-api/main', mode: 'ask', by: 'voice' },
		]);
		expect(result).toMatchObject({ reply: 'checkout api, main is in Ask mode.' });
	});

	it('Skip → Voice OS asks first, nothing switched', async () => {
		const { tools, actions } = createContext();
		const result = await executeTool('set_mode', { ref: null, mode: 'skip' }, tools);

		expect(actions).toEqual([{ type: 'offer_switch', ref: 'store-front/main', kind: 'skip_mode' }]);
		expect(result).toMatchObject({ ok: false, isFinal: true });
	});

	it('a yes to "Skip permissions for X?" → switched', async () => {
		const { tools, actions } = createContext({
			patch: { switchOffer: { ref: 'store-front/main', at: 900, kind: 'skip_mode' } },
		});

		await executeTool('set_mode', { ref: 'store-front/main', mode: 'skip' }, tools);

		expect(actions).toEqual([
			{ type: 'set_mode', ref: 'store-front/main', mode: 'skip', by: 'voice' },
		]);
	});

	it('the mode it already has → said, nothing dispatched', async () => {
		const { tools, actions } = createContext({
			patch: { modes: { 'store-front/main': { mode: 'plan' } } },
		});
		const result = await executeTool('set_mode', { ref: null, mode: 'plan' }, tools);

		expect(actions).toEqual([]);
		expect(result).toMatchObject({ reply: 'store front, main is already in Plan.' });
	});

	it('a setup session, no session on screen, or an unknown mode → nothing switched', async () => {
		for (const [input, screen] of [
			[{ ref: 'setup', mode: 'plan' }, 'store-front/main'],
			[{ ref: null, mode: 'plan' }, null],
			[{ ref: null, mode: 'loud' }, 'store-front/main'],
		] as const) {
			const { tools, actions } = createContext({ screen });

			await executeTool('set_mode', input, tools);
			expect(actions).toEqual([]);
		}
	});
});
