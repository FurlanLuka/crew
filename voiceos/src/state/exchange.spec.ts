import { describe, expect, it } from 'bun:test';
import { EXCHANGE_IDLE_MS, type Input, type State } from '../shared/protocol.js';
import { createInitialState, reduce } from './reducer.js';
import { isMidExchangeWithScreen, pruneExchange, readSubject } from './exchange.js';
import { worktree } from '../../test/support/reduce.js';

const SCREEN = 'store/main';
const OTHER = 'checkout/main';

// Inputs at the times given, so lapses can be tested.
const runAt = (steps: [number, Input][], start: State): State =>
	steps.reduce((state, [at, input]) => {
		const seq = state.seq + 1;

		return reduce(state, { seq, at, id: `i${seq}`, input }).state;
	}, start);

const onScreen = (): State =>
	runAt(
		[
			[
				1,
				{
					type: 'worktrees',
					worktrees: [worktree(SCREEN), worktree(OTHER), worktree('signals/main')],
				},
			],
			[2, { type: 'switch_view', view: { kind: 'session', ref: SCREEN } }],
			[3, { type: 'start_session', ref: OTHER }],
			[4, { type: 'session_started', ref: OTHER } as Input],
		],
		createInitialState(),
	);

const said = (ref: string): Input => ({
	type: 'send',
	ref,
	text: 'is the build green?',
	isSpoken: true,
});

// A line of the session's, played to its end: `spoken` then `spoken_ended`.
const heardAnswer = (state: State, at: number, ref = OTHER, patch: Partial<Input> = {}): State => {
	const withLine = runAt(
		[[at, { type: 'spoken', text: 'Yes.', source: 'narrator', ref, isAnswer: true }]],
		state,
	);
	const lineId = withLine.spoken.at(-1)?.id ?? '';

	return runAt(
		[[at + 1, { type: 'spoken_ended', lineId, isCut: false, ...patch } as Input]],
		withLine,
	);
};

describe('the exchange', () => {
	it('words to another session → it is the subject; the screen is not mid-exchange', () => {
		const state = runAt([[10, said(OTHER)]], onScreen());

		expect(state.exchange).toMatchObject({ ref: OTHER, reason: 'named', answeredTurns: 0 });
		expect(readSubject(state, 20)).toBe(OTHER);
		expect(isMidExchangeWithScreen(state, 20)).toBe(false);
	});

	it('words to the screen → mid-exchange with it, no subject', () => {
		const state = runAt([[10, said(SCREEN)]], onScreen());

		expect(state.exchange).toMatchObject({ ref: SCREEN, reason: 'screen' });
		expect(readSubject(state, 20)).toBeNull();
		expect(isMidExchangeWithScreen(state, 20)).toBe(true);
	});

	it('typed words start nothing: only speech is a conversation', () => {
		const state = runAt([[10, { type: 'send', ref: OTHER, text: 'hi' }]], onScreen());

		expect(state.exchange).toBeNull();
	});

	it('a second message to the subject → a follow-up; its answer heard to the end counts once per turn', () => {
		const asked = runAt(
			[
				[10, said(OTHER)],
				[20, said(OTHER)],
			],
			onScreen(),
		);
		expect(asked.exchange?.reason).toBe('follow_up');

		const once = heardAnswer(asked, 30);
		const twice = heardAnswer(once, 40);

		expect(once.exchange).toMatchObject({ answeredTurns: 1, lastAt: 31 });
		expect(twice.exchange).toMatchObject({ answeredTurns: 1, lastAt: 41 });
	});

	it('an answer cut off, never played, or from another session → not heard', () => {
		const asked = runAt([[10, said(OTHER)]], onScreen());

		expect(heardAnswer(asked, 30, OTHER, { isCut: true }).exchange?.answeredTurns).toBe(0);
		expect(heardAnswer(asked, 30, OTHER, { isUnplayed: true }).exchange?.answeredTurns).toBe(0);
		expect(heardAnswer(asked, 30, 'signals/main').exchange?.answeredTurns).toBe(0);
	});

	it('a minute after its last answer → lapsed; a stale timer from before that answer changes nothing', () => {
		const answered = heardAnswer(runAt([[10, said(OTHER)]], onScreen()), 30);
		const stale = runAt(
			[[EXCHANGE_IDLE_MS + 10, { type: 'exchange_expired', ref: OTHER, lastAt: 10 }]],
			answered,
		);
		const lapsed = runAt(
			[[EXCHANGE_IDLE_MS + 31, { type: 'exchange_expired', ref: OTHER, lastAt: 31 }]],
			answered,
		);

		expect(stale.exchange?.ref).toBe(OTHER);
		expect(lapsed.exchange).toBeNull();
		// Read with the clock too, before the timer fires.
		expect(readSubject(answered, 31 + EXCHANGE_IDLE_MS)).toBeNull();
	});

	it('switching to the subject carries the conversation onto the screen; switching elsewhere ends it', () => {
		const talking = runAt([[10, said(OTHER)]], onScreen());
		const onSubject = runAt(
			[[20, { type: 'switch_view', view: { kind: 'session', ref: OTHER } }]],
			talking,
		);
		const elsewhere = runAt([[20, { type: 'switch_view', view: { kind: 'grid' } }]], talking);

		expect(onSubject.exchange?.ref).toBe(OTHER);
		expect(isMidExchangeWithScreen(onSubject, 30)).toBe(true);
		expect(elsewhere.exchange).toBeNull();
	});

	it('words for the screen while a subject is live → the subject ends', () => {
		const state = runAt(
			[
				[10, said(OTHER)],
				[20, said(SCREEN)],
			],
			onScreen(),
		);

		expect(state.exchange?.ref).toBe(SCREEN);
		expect(readSubject(state, 30)).toBeNull();
	});

	it('cleared from the page → gone; its session removed → gone', () => {
		const talking = runAt([[10, said(OTHER)]], onScreen());

		expect(runAt([[20, { type: 'clear_exchange' }]], talking).exchange).toBeNull();
		expect(pruneExchange(talking.exchange, (ref) => ref !== OTHER)).toBeNull();
		expect(pruneExchange(talking.exchange, () => true)).toBe(talking.exchange);
	});

	describe('the switch offer', () => {
		// Two turns of the subject answered, each heard to the end.
		const twoTurns = (): State => {
			const first = heardAnswer(
				runAt(
					[
						[10, said(OTHER)],
						[12, { type: 'turn_ended', ref: OTHER, costUsd: 0, text: 'Yes.' }],
					],
					onScreen(),
				),
				20,
			);

			return runAt([[30, said(OTHER)]], first);
		};

		const lastEffects = (state: State, at: number, patch: Partial<Input> = {}) => {
			const withLine = runAt(
				[
					[
						at,
						{
							type: 'spoken',
							text: 'Lint is clean.',
							source: 'narrator',
							ref: OTHER,
							isAnswer: true,
							...patch,
						} as Input,
					],
				],
				state,
			);
			const lineId = withLine.spoken.at(-1)?.id ?? '';
			const seq = withLine.seq + 1;

			return reduce(withLine, {
				seq,
				at: at + 1,
				id: `i${seq}`,
				input: { type: 'spoken_ended', lineId, isCut: false },
			});
		};

		it('the second turn answered → "Switch to …?" asked once, as a real offer', () => {
			const { state, effects } = lastEffects(twoTurns(), 40);

			expect(state.switchOffer).toEqual({ ref: OTHER, at: 41 });
			expect(state.exchange?.hasOfferedSwitch).toBe(true);
			expect(effects).toContainEqual(
				expect.objectContaining({
					type: 'speak',
					text: 'Switch to checkout, main?',
					isAsking: true,
				}),
			);

			const closed = runAt([[42, { type: 'switch_offer_closed', at: 41 }]], state);
			const third = lastEffects(runAt([[50, said(OTHER)]], closed), 60);

			expect(third.state.switchOffer).toBeNull();
		});

		it('an answer that asks something → no offer: the yes belongs to that question', () => {
			const { state } = lastEffects(twoTurns(), 40, { isAsking: true });

			expect(state.switchOffer).toBeNull();
		});

		it('a switch closes it; a stale close for an older offer changes nothing', () => {
			const { state } = lastEffects(twoTurns(), 40);

			expect(
				runAt([[45, { type: 'switch_view', view: { kind: 'session', ref: OTHER } }]], state)
					.switchOffer,
			).toBeNull();
			expect(
				runAt([[45, { type: 'switch_offer_closed', at: 10 }]], state).switchOffer,
			).not.toBeNull();
		});

		it('offered for a question only announced → said the same way', () => {
			const seq = onScreen().seq + 1;
			const { state, effects } = reduce(onScreen(), {
				seq,
				at: 10,
				id: `i${seq}`,
				input: { type: 'offer_switch', ref: OTHER },
			});

			expect(state.switchOffer).toEqual({ ref: OTHER, at: 10 });
			expect(effects).toContainEqual(
				expect.objectContaining({ text: 'Switch to checkout, main?' }),
			);
		});
	});
});

describe('what goes when sessions go', () => {
	it('a worktree removed → its conversation, update and history entry go; the others stay', () => {
		const state = runAt(
			[
				[11, { type: 'meanwhile_added', ref: OTHER, kind: 'done', about: 'the retries' }],
				[12, { type: 'meanwhile_added', ref: SCREEN, kind: 'done', about: 'the locale' }],
				[13, { type: 'switch_view', view: { kind: 'session', ref: OTHER } }],
				[14, { type: 'switch_view', view: { kind: 'session', ref: SCREEN } }],
				[15, said(OTHER)],
				[16, { type: 'worker_exited', ref: OTHER, error: null }],
			],
			onScreen(),
		);
		expect(readSubject(state, 17)).toBe(OTHER);

		const removed = runAt(
			[[17, { type: 'worktrees', worktrees: [worktree(SCREEN), worktree('signals/main')] }]],
			state,
		);

		expect(removed.exchange).toBeNull();
		expect(removed.meanwhile.map((item) => item.ref)).toEqual([SCREEN]);
		expect(
			removed.viewHistory.some(({ view }) => view.kind === 'session' && view.ref === OTHER),
		).toBe(false);
	});

	it("a machine removed → its sessions' conversation, updates and views go, this Mac's stay", () => {
		const REMOTE = 'vm1:crew/main';
		const state = runAt(
			[
				[1, { type: 'machines', machines: [{ id: 'vm1', host: 'vm1', name: 'Build box' }] }],
				[2, { type: 'worktrees', worktrees: [worktree(SCREEN), worktree(REMOTE)] }],
				[3, { type: 'switch_view', view: { kind: 'session', ref: SCREEN } }],
				[4, { type: 'switch_view', view: { kind: 'grid', machine: 'vm1' } }],
				[5, { type: 'switch_view', view: { kind: 'session', ref: REMOTE } }],
				[6, { type: 'switch_view', view: { kind: 'session', ref: SCREEN } }],
				[7, { type: 'send', ref: REMOTE, text: 'hi', isSpoken: true }],
				[8, { type: 'meanwhile_added', ref: REMOTE, kind: 'done', about: null }],
				[9, { type: 'remove_machine', id: 'vm1' }],
			],
			createInitialState(),
		);

		expect(state.exchange).toBeNull();
		expect(state.meanwhile).toEqual([]);
		// Build box's grid and its session are gone; this Mac's session and the start stay.
		expect(state.viewHistory.map(({ view }) => view)).toEqual([
			{ kind: 'session', ref: SCREEN },
			{ kind: 'machines' },
		]);
	});
});

describe("a busy session's update", () => {
	it('a newer update replaces its older one but keeps its place in the wait', () => {
		const state = runAt(
			[
				[0, { type: 'meanwhile_added', ref: OTHER, kind: 'done', about: 'first' }],
				[30, { type: 'meanwhile_added', ref: OTHER, kind: 'needs', about: 'second' }],
			],
			onScreen(),
		);

		expect(state.meanwhile).toEqual([{ ref: OTHER, kind: 'needs', about: 'second', at: 0 }]);
	});
});

describe('switch, then send in one turn', () => {
	it("the words go to the session now on screen: no subject, the screen's conversation", () => {
		const state = runAt(
			[
				[10, { type: 'switch_view', view: { kind: 'session', ref: OTHER } }],
				[11, said(OTHER)],
			],
			onScreen(),
		);

		expect(readSubject(state, 20)).toBeNull();
		expect(state.exchange?.reason).toBe('screen');
	});
});
