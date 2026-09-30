// A tool context over a small state (two idle store-front sessions and a stopped checkout), for the
// tools' specs: every call the tools make is recorded, nothing reaches a server.
import { createInitialState, createSession } from '../../src/state/reducer.js';
import type { Action, State } from '../../src/shared/protocol.js';
import type { ToolContext } from '../../src/tools/tools.js';
import { englishJudge } from './english-judge.js';
import { createNullNotes } from './notes.js';

// What every instruction carries to the reducer, which says the situation line when there is one.
export const INSTRUCTION_ACK = { kind: 'instruction' } as const;

export const createToolContext = (patch: Partial<State> = {}) => {
	const refs = ['store-front/main', 'store-front/wrk1', 'checkout-api/main'];
	const sessions: State['sessions'] = Object.fromEntries(
		refs.map((ref) => [
			ref,
			{
				...createSession({ ref, label: ref, branch: '', cwd: '/w', dirs: [], isPinned: false }),
				status: 'idle' as const,
			},
		]),
	);
	sessions['checkout-api/main'] = {
		...sessions['checkout-api/main']!,
		status: 'stopped',
	};
	const state: State = {
		...createInitialState(),
		sessions,
		order: refs,
		focus: 'store-front/main',
		...patch,
	};
	const actions: Action[] = [];
	const tools: ToolContext = {
		getState: () => state,
		dispatch: (action) => actions.push(action),
		readHistory: ({ ref, query, limit }) => [
			{ ts: '2026-09-24', ref: ref ?? 'store-front/main', asked: query, did: `limit ${limit}` },
		],
		now: () => 0,
		asks: state.asks,
		mute: () => undefined,
		saveDebugNote: () => undefined,
		judge: englishJudge,
		notes: createNullNotes(),
		setListenMode: () => 'changed' as const,
		openUrl: () => true,
	};

	return { tools, actions };
};
