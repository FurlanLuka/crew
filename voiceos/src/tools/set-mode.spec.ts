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

	it('a yes to "Skip permissions for X?" → switched, "Skipping permissions." said', async () => {
		const { tools, actions } = createContext({
			patch: { switchOffer: { ref: 'store-front/main', at: 900, kind: 'skip_mode' } },
		});
		const result = await executeTool('set_mode', { ref: 'store-front/main', mode: 'skip' }, tools);

		expect(actions).toEqual([
			{ type: 'set_mode', ref: 'store-front/main', mode: 'skip', by: 'voice' },
		]);
		expect(result).toMatchObject({ reply: 'Skipping permissions.' });
	});

	it('a yes for a session not on screen → said by its name', async () => {
		const { tools } = createContext({
			patch: { switchOffer: { ref: 'checkout-api/main', at: 900, kind: 'skip_mode' } },
		});

		expect(
			await executeTool('set_mode', { ref: 'checkout-api/main', mode: 'skip' }, tools),
		).toMatchObject({ reply: 'checkout api, main is skipping permissions.' });
	});

	it('a Skip confirm for another session, or one gone stale → asked again, nothing switched', async () => {
		for (const switchOffer of [
			{ ref: 'checkout-api/main', at: 900, kind: 'skip_mode' as const },
			{ ref: 'store-front/main', at: -100_000, kind: 'skip_mode' as const },
		]) {
			const { tools, actions } = createContext({ patch: { switchOffer } });

			await executeTool('set_mode', { ref: null, mode: 'skip' }, tools);

			expect(actions).toEqual([
				{ type: 'offer_switch', ref: 'store-front/main', kind: 'skip_mode' },
			]);
		}
	});

	it('an inactive session named → switched all the same: it starts in it', async () => {
		const { tools, actions } = createContext({ patch: { active: ['store-front/main'] } });
		const result = await executeTool('set_mode', { ref: 'checkout-api/main', mode: 'plan' }, tools);

		expect(actions).toEqual([
			{ type: 'set_mode', ref: 'checkout-api/main', mode: 'plan', by: 'voice' },
		]);
		expect(result).toMatchObject({ reply: 'checkout api, main is in Plan mode.' });
	});

	it('the mode it already has → said, nothing dispatched', async () => {
		const { tools, actions } = createContext({
			patch: { modes: { 'store-front/main': { mode: 'plan' } } },
		});
		const result = await executeTool('set_mode', { ref: null, mode: 'plan' }, tools);

		expect(actions).toEqual([]);
		expect(result).toMatchObject({ reply: 'store front, main is already in Plan.' });
	});

	it.each([
		[
			'a setup session',
			{ ref: 'setup', mode: 'plan' },
			'store-front/main',
			{ ok: true, reply: 'Setup sessions stay in Auto.' },
		],
		[
			'no session on screen',
			{ ref: null, mode: 'plan' },
			null,
			{ ok: false, content: 'no session on screen: ask which session, in a few words' },
		],
		[
			'an unknown mode',
			{ ref: null, mode: 'loud' },
			'store-front/main',
			{ ok: false, content: 'mode must be auto, plan, ask or skip' },
		],
	] as const)('%s → nothing switched, and why', async (_case, input, screen, outcome) => {
		const { tools, actions } = createContext({ screen });

		expect(await executeTool('set_mode', input, tools)).toMatchObject(outcome);
		expect(actions).toEqual([]);
	});
});
