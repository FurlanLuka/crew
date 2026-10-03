import { describe, expect, it } from 'bun:test';
import { run, worktree } from '../../test/support/reduce.js';
import { listHeardAsks } from '../shared/active.js';
import { isSilenced } from '../speech/connect.js';
import type { PendingAsk, State } from '../shared/protocol.js';
import { createInitialState, createSession, type Effect } from '../state/reducer.js';
import {
	describeMoment,
	describeSessionState,
	readScreenAsk,
	readScreenDenial,
	readSessionAsk,
} from './moments.js';

const NOW = 1_000_000;

const createState = (patch: Partial<State> = {}): State => ({
	...createInitialState(),
	sessions: Object.fromEntries(
		['store-front/main', 'checkout-api/main', 'vm1:api/main'].map((ref) => [
			ref,
			createSession({ ref, label: ref, branch: 'b', cwd: '/w', dirs: [], isPinned: false }),
		]),
	),
	...patch,
});

describe('describeMoment', () => {
	it('nothing asked or waiting → no row', () =>
		expect(describeMoment(createState(), NOW)).toBeNull());

	it('"Sent to X. Switch there?" → Switch goes there; Stay here sets it aside', () => {
		const moment = describeMoment(
			createState({ switchOffer: { ref: 'checkout-api/main', at: 1 } }),
			NOW,
		);

		expect(moment?.text).toBe('Sent to checkout-api/main. Switch there?');
		expect(moment?.answers).toEqual([
			{
				label: 'Switch',
				action: { type: 'switch_view', view: { kind: 'session', ref: 'checkout-api/main' } },
				isPrimary: true,
			},
			{ label: 'Stay here', action: null },
		]);
	});

	it('an activate offer → Activate dispatches activate', () => {
		const moment = describeMoment(
			createState({ switchOffer: { ref: 'checkout-api/main', at: 1, kind: 'activate' } }),
			NOW,
		);

		expect(moment?.text).toBe('checkout-api/main isn’t active. Activate it?');
		expect(moment?.answers[0]?.action).toEqual({ type: 'activate', ref: 'checkout-api/main' });
	});

	it('a deactivate confirm → Deactivate dispatches deactivate', () =>
		expect(
			describeMoment(
				createState({ switchOffer: { ref: 'store-front/main', at: 1, kind: 'deactivate' } }),
				NOW,
			)?.answers[0]?.action,
		).toEqual({ type: 'deactivate', ref: 'store-front/main' }));

	it('"For X?" → settle_target either way, and it beats a switch offer', () => {
		const moment = describeMoment(
			createState({
				targetAsk: { ref: 'checkout-api/main', screen: 'store-front/main', text: 'run it', at: 7 },
				switchOffer: { ref: 'checkout-api/main', at: 1 },
			}),
			NOW,
		);

		expect(moment?.text).toBe('For checkout-api/main?');
		expect(moment?.answers.map((answer) => answer.action)).toEqual([
			{ type: 'settle_target', at: 7, toTarget: true },
			{ type: 'settle_target', at: 7, toTarget: false },
		]);
	});

	it('the meanwhile line just said → a button per session it names', () => {
		const moment = describeMoment(
			createState({
				spoken: [
					{
						id: 'l1',
						text: 'Meanwhile: checkout finished; vm1 api asks.',
						source: 'narrator',
						at: NOW - 5000,
						isUpdate: true,
						refs: ['checkout-api/main', 'vm1:api/main'],
					},
				],
			}),
			NOW,
		);

		expect(moment?.answers.map((answer) => answer.label)).toEqual([
			'Go to checkout-api/main',
			'Go to vm1:api/main',
		]);
	});

	it('the meanwhile line about the session now on screen → no card: its stream says it (debug note 50)', () =>
		expect(
			describeMoment(
				createState({
					view: { kind: 'session', ref: 'checkout-api/main' },
					spoken: [
						{
							id: 'l1',
							text: 'Meanwhile, checkout finished. Switch there?',
							source: 'narrator',
							at: NOW - 5000,
							isUpdate: true,
							refs: ['checkout-api/main'],
						},
					],
				}),
				NOW,
			),
		).toBeNull());

	it('the meanwhile line about the screen and another session → still shown: the other one is news', () =>
		expect(
			describeMoment(
				createState({
					view: { kind: 'session', ref: 'checkout-api/main' },
					spoken: [
						{
							id: 'l1',
							text: 'Meanwhile: checkout finished; vm1 api asks.',
							source: 'narrator',
							at: NOW - 5000,
							isUpdate: true,
							refs: ['checkout-api/main', 'vm1:api/main'],
						},
					],
				}),
				NOW,
			)?.answers.map((answer) => answer.label),
		).toEqual(['Go to checkout-api/main', 'Go to vm1:api/main']));

	it('"Send it now?" → Send now promotes the queued words; Keep it queued sets it aside', () => {
		const moment = describeMoment(
			createState({
				switchOffer: { ref: 'store-front/main', at: 1, kind: 'send_now', queuedId: 'q1' },
			}),
			NOW,
		);

		expect(moment?.text).toBe("Queued for after store-front/main's current work. Send it now?");
		expect(moment?.answers).toEqual([
			{
				label: 'Send now',
				action: {
					type: 'promote_queued',
					ref: 'store-front/main',
					queuedId: 'q1',
					answersOffer: true,
				},
				isPrimary: true,
			},
			{ label: 'Keep it queued', action: null },
		]);
	});

	it('"Send it now?" with two of theirs queued → Send now sends both, as a spoken yes does', () => {
		const base = createState({
			switchOffer: { ref: 'store-front/main', at: 1, kind: 'send_now', queuedId: 'q2' },
		});
		const session = base.sessions['store-front/main']!;
		const state = {
			...base,
			sessions: {
				...base.sessions,
				'store-front/main': {
					...session,
					queue: [
						{ id: 'q1', text: 'run the linter', at: 1 },
						{ id: 'q2', text: 'and the types', at: 2 },
					],
				},
			},
		};

		expect(describeMoment(state, NOW)?.answers[0]?.action).toEqual({
			type: 'promote_all_queued',
			ref: 'store-front/main',
			answersOffer: true,
		});
	});

	it('updates waiting for the quiet → "Hear them now" plays them', () =>
		expect(
			describeMoment(
				createState({
					meanwhile: [{ ref: 'checkout-api/main', kind: 'done', about: null, at: 1 }],
				}),
				NOW,
			)?.answers[0]?.action,
		).toEqual({ type: 'play_meanwhile' }));
});

describe('readScreenAsk', () => {
	const plan = (ref: string) =>
		({ id: `a-${ref}`, ref, at: 1, kind: 'plan', input: {}, plan: 'p' }) as const;

	it("the session on screen's open ask, never another session's", () => {
		const state = createState({
			view: { kind: 'session', ref: 'store-front/main' },
			asks: [plan('checkout-api/main'), plan('store-front/main')],
		});

		expect(readScreenAsk(state)?.id).toBe('a-store-front/main');
	});

	it('another session asking, or no session on screen → nothing docked', () => {
		const asks = [plan('checkout-api/main')];

		expect(
			readScreenAsk(createState({ view: { kind: 'session', ref: 'store-front/main' }, asks })),
		).toBeNull();
		expect(readScreenAsk(createState({ view: { kind: 'active' }, asks }))).toBeNull();
	});
});

describe("a setup session's ask: Set up's to answer, never Voice OS's", () => {
	const VM1 = { id: 'vm1', host: 'dev@vm1.example.com', name: 'Build box' };
	const SETUP_REFS = ['setup', 'vm1:setup'];

	const question = (ref: string): PendingAsk => ({
		id: `q-${ref}`,
		ref,
		at: 1,
		kind: 'question',
		input: {},
		questions: [
			{
				question: 'How should the worker reach Redis?',
				multiSelect: false,
				options: [{ label: 'I have Redis on :6379' }, { label: 'Skip the worker' }],
			},
		],
	});

	// This Mac's setup and vm1's, both running, each asking; a worktree session on screen.
	const opened = () =>
		run([
			{ type: 'machines', machines: [VM1] },
			{
				type: 'worktrees',
				worktrees: [
					{ ...worktree('setup'), isPinned: true },
					worktree('store-front/main'),
					{ ...worktree('vm1:setup'), label: 'setup', isPinned: true },
				],
			},
			{ type: 'session_started', ref: 'setup' },
			{
				type: 'machine_resynced',
				id: 'vm1',
				inputs: [{ type: 'session_started', ref: 'vm1:setup' }],
			},
			{ type: 'ask_opened', ask: question('setup') },
			{ type: 'ask_opened', ask: question('vm1:setup') },
		]);

	// What reaches the voice: the speech layer silences every line about a session voice does not hear.
	const spoken = (state: State, effects: Effect[]) =>
		effects.filter((effect) => effect.type === 'speak' && !isSilenced(state, effect));

	const resolved = (effects: Effect[]) =>
		effects.flatMap((effect) =>
			effect.type === 'resolve_ask' ? [{ ref: effect.ref, behavior: effect.result.behavior }] : [],
		);

	it('readable for Set up on each machine, never heard, never docked in Voice OS', () => {
		const { state, effects } = opened();

		expect(spoken(state, effects)).toEqual([]);
		expect(listHeardAsks(state)).toEqual([]);

		for (const ref of SETUP_REFS) {
			expect(readSessionAsk(state, ref)?.id).toBe(`q-${ref}`);
			expect(readScreenAsk({ ...state, view: { kind: 'session', ref } })).toBeNull();
		}

		expect(
			readScreenAsk({ ...state, view: { kind: 'session', ref: 'store-front/main' } }),
		).toBeNull();
	});

	for (const ref of SETUP_REFS) {
		it(`${ref}: an option clicked → resolved there, nothing said; ✕ → declined`, () => {
			const start = opened().state;
			const answered = run(
				[
					{
						type: 'answer_question',
						askId: `q-${ref}`,
						answers: { 'How should the worker reach Redis?': 'Skip the worker' },
					},
				],
				{ start },
			);

			expect(resolved(answered.effects)).toEqual([{ ref, behavior: 'allow' }]);
			expect(spoken(answered.state, answered.effects)).toEqual([]);
			expect(readSessionAsk(answered.state, ref)).toBeNull();

			const declined = run([{ type: 'decline_question', askId: `q-${ref}` }], { start });

			expect(resolved(declined.effects)).toEqual([{ ref, behavior: 'deny' }]);
			expect(readSessionAsk(declined.state, ref)).toBeNull();
		});
	}
});

describe('describeSessionState', () => {
	it('an open ask is not the state row: it is docked above the voice bar', () =>
		expect(
			describeSessionState(
				createState({
					asks: [{ id: 'a1', ref: 'store-front/main', at: 1, kind: 'plan', input: {}, plan: 'p' }],
				}),
				'store-front/main',
			).kind,
		).toBe('none'));

	it("a remote machine that dropped → 'dropped' with its name", () =>
		expect(
			describeSessionState(
				createState({
					machines: {
						vm1: {
							id: 'vm1',
							host: 'vm1',
							name: 'Build box',
							status: 'unreachable',
							detail: null,
							since: 1,
						},
					},
				}),
				'vm1:api/main',
			),
		).toEqual({ kind: 'dropped', machine: 'Build box', detail: null }));

	it('stopped with an error → crashed', () => {
		const state = createState();
		const session = state.sessions['store-front/main'];

		if (session) {
			state.sessions['store-front/main'] = { ...session, status: 'stopped', error: 'exit 1' };
		}

		expect(describeSessionState(state, 'store-front/main')).toEqual({
			kind: 'crashed',
			error: 'exit 1',
		});
	});

	it('nothing wrong → none', () =>
		expect(describeSessionState(createState(), 'store-front/main').kind).toBe('none'));

	it('a blocked call is not the state row either: it is docked, for the session on screen only', () => {
		const denial = {
			id: 'd1',
			ref: 'store-front/main',
			at: 1,
			toolName: 'Bash',
			summary: 'rm -rf dist',
		};
		const blocked = createState({ denials: [denial] });

		expect(describeSessionState(blocked, 'store-front/main').kind).toBe('none');
		expect(
			readScreenDenial({ ...blocked, view: { kind: 'session', ref: 'store-front/main' } }),
		).toEqual(denial);
		expect(readScreenDenial({ ...blocked, view: { kind: 'active' } })).toBeNull();
	});
});
