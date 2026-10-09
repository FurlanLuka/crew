import { describe, expect, it } from 'bun:test';
import type { Input, PendingAsk, State } from '../shared/protocol.js';
import { idleSession, REF, run, worktree } from '../../test/support/reduce.js';

const setMode = (mode: 'auto' | 'plan' | 'ask' | 'skip', ref = REF): Input => ({
	type: 'set_mode',
	ref,
	mode,
	by: 'page',
});

const lastNotice = (state: State, ref = REF): string | undefined => {
	const item = state.sessions[ref]?.stream.at(-1);

	return item?.kind === 'notice' ? item.text : undefined;
};

const planAsk: PendingAsk = {
	id: 'plan1',
	ref: REF,
	at: 1,
	kind: 'plan',
	input: { plan: 'Add the retry.' },
	plan: 'Add the retry.',
};

const withPlanAsk = (start: State): State =>
	run([{ type: 'ask_opened', ask: planAsk }], { start }).state;

const stopped = (): State => run([{ type: 'worktrees', worktrees: [worktree(REF)] }]).state;

describe('set_mode', () => {
	it('a running session → kept, its worker switched, "Mode: Plan." in its stream', () => {
		const { state, effects } = run([setMode('plan')], { start: idleSession() });

		expect(state.modes[REF]).toEqual({ mode: 'plan' });
		expect(effects).toEqual([{ type: 'worker_set_mode', ref: REF, mode: 'plan' }]);
		expect(lastNotice(state)).toBe('Mode: Plan.');
	});

	it.each([
		['ask', 'default'],
		['skip', 'bypassPermissions'],
	] as const)('%s → the worker runs Claude Code mode %s', (mode, sdkMode) => {
		expect(run([setMode(mode)], { start: idleSession() }).effects).toEqual([
			{ type: 'worker_set_mode', ref: REF, mode: sdkMode },
		]);
	});

	it('a session not running → kept and said so, nothing sent; its start starts in it', () => {
		const { state, effects } = run([setMode('ask')], { start: stopped() });

		expect(effects).toEqual([]);
		expect(lastNotice(state)).toBe('Mode: Ask. It starts in it.');
		expect(run([{ type: 'activate', ref: REF }], { start: state }).effects).toContainEqual({
			type: 'worker_start',
			ref: REF,
			mode: 'default',
		});
	});

	it('back to Auto → no entry kept; the same mode again → nothing', () => {
		const planned = run([setMode('plan')], { start: idleSession() }).state;
		const auto = run([setMode('auto')], { start: planned });

		expect(auto.state.modes).toEqual({});
		expect(auto.effects).toEqual([{ type: 'worker_set_mode', ref: REF, mode: 'auto' }]);
		expect(run([setMode('plan')], { start: planned }).effects).toEqual([]);
	});

	it('a setup session → stays in Auto, said in its stream', () => {
		const setup = run([
			{ type: 'worktrees', worktrees: [{ ...worktree('setup'), isPinned: true }] },
		]).state;
		const { state, effects } = run([setMode('skip', 'setup')], { start: setup });

		expect(state.modes).toEqual({});
		expect(effects).toEqual([]);
		expect(lastNotice(state, 'setup')).toBe('Setup sessions stay in Auto.');
	});
});

describe('plan approval', () => {
	it('Plan from Ask → approving returns to Ask, carried on the allow itself', () => {
		const planned = run([setMode('ask'), setMode('plan')], { start: idleSession() }).state;

		expect(planned.modes[REF]).toEqual({ mode: 'plan', beforePlan: 'ask' });

		const { state, effects } = run([{ type: 'answer_plan', askId: 'plan1', isApproved: true }], {
			start: withPlanAsk(planned),
		});

		expect(state.modes[REF]).toEqual({ mode: 'ask' });
		expect(effects).toContainEqual({
			type: 'resolve_ask',
			ref: REF,
			askId: 'plan1',
			result: {
				behavior: 'allow',
				updatedInput: planAsk.input,
				updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
			},
		});
	});

	it('a plan Claude entered by itself (the chip on Auto) → approving keeps Auto', () => {
		const { state, effects } = run([{ type: 'answer_plan', askId: 'plan1', isApproved: true }], {
			start: withPlanAsk(idleSession()),
		});

		expect(state.modes).toEqual({});
		expect(effects).toContainEqual(
			expect.objectContaining({
				type: 'resolve_ask',
				result: expect.objectContaining({
					updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }],
				}),
			}),
		);
	});

	it('changes asked for → Plan stays', () => {
		const planned = withPlanAsk(run([setMode('plan')], { start: idleSession() }).state);
		const { state } = run(
			[{ type: 'answer_plan', askId: 'plan1', isApproved: false, message: 'smaller' }],
			{ start: planned },
		);

		expect(state.modes[REF]).toEqual({ mode: 'plan' });
	});
});

describe('allow once', () => {
	const allowedOnce = (start: State): State => {
		const denied = run([{ type: 'denied', ref: REF, toolName: 'Bash', summary: 'run git push' }], {
			start,
		}).state;

		return run([{ type: 'allow_denied', denialId: denied.denials.at(-1)?.id ?? '' }], {
			start: denied,
		}).state;
	};

	it("the turn ends → the session's own mode is back, not Auto", () => {
		const planned = run([{ type: 'modes_loaded', modes: { [REF]: { mode: 'plan' } } }], {
			start: idleSession(),
		}).state;
		const { effects } = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'pushed' }], {
			start: allowedOnce(planned),
		});

		expect(effects).toContainEqual({ type: 'worker_set_mode', ref: REF, mode: 'plan' });
	});

	it('a mode picked while it waits → the allowance ends, the turn end undoes nothing', () => {
		const picked = run([setMode('skip')], { start: allowedOnce(idleSession()) }).state;

		expect(picked.sessions[REF]?.allowOnce).toBeNull();
		expect(
			run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'pushed' }], { start: picked })
				.effects,
		).not.toContainEqual(expect.objectContaining({ type: 'worker_set_mode' }));
	});
});

describe('always on a permission card', () => {
	it('a suggestion that would change the mode → dropped; the rest kept', () => {
		const ask: PendingAsk = {
			id: 'p1',
			ref: REF,
			at: 1,
			kind: 'permission',
			toolName: 'Edit',
			summary: 'edit src/a.ts',
			input: { file_path: 'src/a.ts' },
			suggestions: [
				{ type: 'setMode', mode: 'acceptEdits', destination: 'session' },
				{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow' },
			],
		};
		const { effects } = run(
			[
				{ type: 'ask_opened', ask },
				{ type: 'answer_permission', askId: 'p1', decision: 'always' },
			],
			{ start: idleSession() },
		);

		expect(effects).toContainEqual(
			expect.objectContaining({
				type: 'resolve_ask',
				result: {
					behavior: 'allow',
					updatedInput: ask.input,
					updatedPermissions: [
						{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow' },
					],
				},
			}),
		);
	});
});

describe('mode_refused', () => {
	it('Skip refused as root → the mode it kept, and why, in its stream', () => {
		const skipped = run([setMode('skip')], { start: idleSession() }).state;
		const { state } = run(
			[
				{
					type: 'mode_refused',
					ref: REF,
					mode: 'bypassPermissions',
					kept: 'default',
					reason: 'root',
				},
			],
			{ start: skipped },
		);

		expect(state.modes[REF]).toEqual({ mode: 'ask' });
		expect(lastNotice(state)).toBe(
			"Skip permissions isn't available here: Claude Code refuses it when it runs as root. Mode: Ask.",
		);
	});
});

describe('modes_loaded', () => {
	it('saved modes merge under the ones picked since boot; bad, Auto and setup entries dropped', () => {
		const picked = run([setMode('ask')], { start: idleSession() }).state;
		const { state } = run(
			[
				{
					type: 'modes_loaded',
					modes: {
						[REF]: { mode: 'skip' },
						'store/wrk1': { mode: 'plan', beforePlan: 'ask' },
						'checkout/main': { mode: 'auto' },
						'admin/main': { mode: 'loud' as never },
						setup: { mode: 'skip' },
					},
				},
			],
			{ start: picked },
		);

		expect(state.modes).toEqual({
			[REF]: { mode: 'ask' },
			'store/wrk1': { mode: 'plan', beforePlan: 'ask' },
		});
	});

	it('loaded before the active set → each session starts in its saved mode', () => {
		const { effects } = run([
			{ type: 'worktrees', worktrees: [worktree(REF)] },
			{ type: 'modes_loaded', modes: { [REF]: { mode: 'skip' } } },
			{ type: 'active_loaded', refs: [REF] },
		]);

		expect(effects).toContainEqual({ type: 'worker_start', ref: REF, mode: 'bypassPermissions' });
	});
});
