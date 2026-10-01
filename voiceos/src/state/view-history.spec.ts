import { describe, expect, it } from 'bun:test';
import type { Input, State } from '../shared/protocol.js';
import { createInitialState, reduce, type Effect } from './reducer.js';
import { worktree } from '../../test/support/reduce.js';

const CREW = 'crew/main';
const CHECKOUT = 'checkout/main';
const SPEAK = 'speak/main';

const runAt = (steps: [number, Input][], start: State): { state: State; effects: Effect[] } =>
	steps.reduce(
		(result, [at, input]) => {
			const seq = result.state.seq + 1;

			return reduce(result.state, { seq, at, id: `i${seq}`, input });
		},
		{ state: start, effects: [] as Effect[] },
	);

const show = (ref: string): Extract<Input, { type: 'switch_view' }> => ({
	type: 'switch_view',
	view: { kind: 'session', ref },
});

const said = (effects: Effect[]) =>
	effects.flatMap((effect) => (effect.type === 'speak' ? [effect.text] : []));

// crew → checkout → speak, all running.
const walked = (): State =>
	runAt(
		[
			[1, { type: 'worktrees', worktrees: [worktree(CREW), worktree(CHECKOUT), worktree(SPEAK)] }],
			...[CREW, CHECKOUT, SPEAK].flatMap((ref, index): [number, Input][] => [
				[2 + index, { type: 'activate', ref }],
				[2 + index, { type: 'session_started', ref } as Input],
			]),
			[10, show(CREW)],
			[11, show(CHECKOUT)],
			[12, show(SPEAK)],
		],
		createInitialState(),
	).state;

describe('go back', () => {
	it('walks the views back one at a time, saying where it lands', () => {
		const once = runAt([[20, { type: 'go_back' }]], walked());
		const twice = runAt([[21, { type: 'go_back' }]], once.state);

		// Active sessions open inside Active, wherever they are gone back to from.
		expect(once.state.view).toEqual({ kind: 'session', ref: CHECKOUT, from: 'active' });
		expect(said(once.effects)).toEqual(['Back to checkout, main.']);
		expect(twice.state.view).toEqual({ kind: 'session', ref: CREW, from: 'active' });
	});

	it('a session that stopped since → passed over, and said', () => {
		const stopped = runAt(
			[[15, { type: 'worker_exited', ref: CHECKOUT, error: null }]],
			walked(),
		).state;
		const back = runAt([[20, { type: 'go_back' }]], stopped);

		expect(back.state.view).toEqual({ kind: 'session', ref: CREW, from: 'active' });
		expect(said(back.effects)).toEqual(['checkout, main stopped. Back to crew, main.']);
	});

	it('a session that was never running when left → still gone back to', () => {
		const idle = runAt(
			[
				[1, { type: 'worktrees', worktrees: [worktree(CREW), worktree(CHECKOUT)] }],
				[2, show(CREW)],
				[3, show(CHECKOUT)],
			],
			createInitialState(),
		).state;
		const back = runAt([[20, { type: 'go_back' }]], idle);

		expect(back.state.view).toEqual({ kind: 'session', ref: CREW });
		expect(said(back.effects)).toEqual(['Back to crew, main.']);
	});

	it('nowhere to go → said, nothing moves', () => {
		const start = runAt(
			[[1, { type: 'worktrees', worktrees: [worktree(CREW)] }]],
			createInitialState(),
		).state;
		const back = runAt([[20, { type: 'go_back' }]], start);

		expect(back.state.view).toEqual(start.view);
		expect(said(back.effects)).toEqual(['Nothing to go back to.']);
	});

	it('a switch the developer asked for by voice is said first; a click is not', () => {
		const voiced = runAt([[20, { ...show(CREW), announce: true }]], walked());
		const clicked = runAt([[20, show(CREW)]], walked());

		expect(said(voiced.effects)[0]).toBe('Switching to crew, main.');
		expect(said(clicked.effects)).not.toContain('Switching to crew, main.');
	});
});

describe('a correction', () => {
	it('the session that got words meant elsewhere is stopped, and Voice OS says so', () => {
		const sent = runAt([[20, { type: 'send', ref: CHECKOUT, text: 'rebuild it' }]], walked()).state;
		const { effects } = runAt(
			[[21, { type: 'interrupt', ref: CHECKOUT, isCorrection: true }]],
			sent,
		);

		expect(said(effects)).toEqual(['Stopped checkout, main.']);
		expect(effects).toContainEqual({ type: 'worker_interrupt', ref: CHECKOUT });
	});
});
