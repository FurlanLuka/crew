import type { Input, PendingAsk, State, WorktreeInfo } from '../../src/shared/protocol.js';
import {
	createInitialState,
	reduce,
	type Effect,
	type ReducerResult,
} from '../../src/state/reducer.js';

export const worktree = (ref: string): WorktreeInfo => ({
	ref,
	label: ref,
	branch: 'main',
	cwd: `/work/${ref}`,
	dirs: [],
	isPinned: false,
});

export interface RunOptions {
	start?: State;
	// The first input's time; each next one is a millisecond later.
	at?: number;
}

export const run = (
	inputs: Input[],
	{ start = createInitialState(), at = 1000 }: RunOptions = {},
): ReducerResult => {
	// Steps through the inputs in turn, keeping the last input's effects.
	let state = start;
	let effects: Effect[] = [];

	for (const [index, input] of inputs.entries()) {
		const seq = state.seq + 1;
		const result = reduce(state, { seq, at: at + index, id: `i${seq}`, input });

		state = result.state;
		effects = result.effects;
	}

	return { state, effects };
};

export const REF = 'store/main';

export const idleSession = (): State =>
	run([
		{ type: 'worktrees', worktrees: [worktree(REF), worktree('store/wrk1')] },
		{ type: 'start_session', ref: REF },
		{ type: 'session_started', ref: REF },
	]).state;

export const runningSession = (): State =>
	run([{ type: 'send', ref: REF, text: 'refactor the router' }], { start: idleSession() }).state;

export const permissionAsk = (id: string, ref = REF): PendingAsk => ({
	id,
	ref,
	at: 1,
	kind: 'permission',
	toolName: 'Bash',
	summary: 'run git push',
	input: { command: 'git push' },
	suggestions: [],
});
