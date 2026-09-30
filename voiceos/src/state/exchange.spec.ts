import { describe, expect, it } from 'bun:test';
import {
	EXCHANGE_IDLE_MS,
	EXCHANGE_WORK_MS,
	SWITCH_OFFER_MS,
	type Input,
	type State,
} from '../shared/protocol.js';
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
		const expire: [number, Input] = [
			EXCHANGE_IDLE_MS + 31,
			{ type: 'exchange_expired', ref: OTHER, lastAt: 31 },
		];
		const lapsed = runAt(
			[[32, { type: 'turn_ended', ref: OTHER, costUsd: 0, text: '' }], expire],
			answered,
		);
		// Still at work on it: the conversation waits for the answer, the minute counted anew.
		const working = runAt([[32, { type: 'turn_started', ref: OTHER }], expire], answered);

		expect(stale.exchange?.ref).toBe(OTHER);
		expect(lapsed.exchange).toBeNull();
		expect(working.exchange).toMatchObject({ ref: OTHER, lastAt: EXCHANGE_IDLE_MS + 31 });
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

		it('two turns answered → no offer: a back-and-forth never asks to switch by itself', () => {
			const { state, effects } = lastEffects(twoTurns(), 40);

			expect(state.switchOffer).toBeNull();
			expect(effects).not.toContainEqual(
				expect.objectContaining({ type: 'speak', text: 'Switch to checkout, main?' }),
			);
		});

		it('an answer that asks something → no offer: the yes belongs to that question', () => {
			const { state } = lastEffects(twoTurns(), 40, { isAsking: true });

			expect(state.switchOffer).toBeNull();
		});

		const offered = (): State => runAt([[40, { type: 'offer_switch', ref: OTHER }]], onScreen());

		it('a switch closes it; a stale close for an older offer changes nothing', () => {
			const state = offered();

			expect(
				runAt([[45, { type: 'switch_view', view: { kind: 'session', ref: OTHER } }]], state)
					.switchOffer,
			).toBeNull();
			expect(
				runAt([[45, { type: 'switch_offer_closed', at: 10 }]], state).switchOffer,
			).not.toBeNull();
		});

		it('its window starts when the question was heard, not when it was queued', () => {
			const asked = runAt(
				[
					[
						40,
						{
							type: 'spoken',
							text: 'Switch to checkout, main?',
							source: 'kernel',
							ref: OTHER,
							isAsking: true,
						},
					],
				],
				offered(),
			);
			const lineId = asked.spoken.at(-1)?.id ?? '';
			// Said only at 55, after a long answer ahead of it in the queue.
			const heard = runAt([[55, { type: 'spoken_ended', lineId, isCut: false }]], asked);

			expect(heard.switchOffer).toEqual({ ref: OTHER, at: 40, heardAt: 55 });
			// The first lapse was armed for an unheard question: it leaves a fresh one alone.
			expect(
				runAt([[60, { type: 'switch_offer_closed', at: 40, isLapse: true }]], heard).switchOffer,
			).not.toBeNull();
			expect(
				runAt(
					[[55 + SWITCH_OFFER_MS, { type: 'switch_offer_closed', at: 40, isLapse: true }]],
					heard,
				).switchOffer,
			).toBeNull();
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

describe('updates heard, and the meanwhile line', () => {
	const updateLine = (ref: string): [number, Input][] => [
		[10, { type: 'meanwhile_added', ref, kind: 'done', about: 'tests pass' }],
		[11, { type: 'line_held', ref, text: 'All tests pass.', isAsking: false } as Input],
		[
			12,
			{
				type: 'spoken',
				text: 'Meanwhile, checkout said: all tests pass.',
				source: 'narrator',
				isUpdate: true,
				refs: [ref],
			},
		],
	];

	it('an update line nobody heard (played in no tab) → not heard: no offer follows a reply', () => {
		const said = runAt(updateLine(OTHER), onScreen());
		const lineId = said.spoken.at(-1)?.id ?? '';
		const unplayed = runAt(
			[[13, { type: 'spoken_ended', lineId, isCut: false, isUnplayed: true }]],
			said,
		);
		const heard = runAt([[13, { type: 'spoken_ended', lineId, isCut: false }]], said);

		expect(unplayed.sessions[OTHER]?.heldLine?.updateHeardAt).toBeUndefined();
		expect(heard.sessions[OTHER]?.heldLine?.updateHeardAt).toBe(13);
	});

	it('the session on screen is left out of the meanwhile line', () => {
		const waiting = runAt(
			[
				[10, { type: 'meanwhile_added', ref: SCREEN, kind: 'done', about: 'locale done' }],
				[11, { type: 'meanwhile_added', ref: OTHER, kind: 'done', about: 'tests pass' }],
			],
			onScreen(),
		);
		const seq = waiting.seq + 1;
		const played = reduce(waiting, {
			seq,
			at: 20,
			id: `i${seq}`,
			input: { type: 'play_meanwhile' },
		});

		expect(played.effects).toEqual([
			expect.objectContaining({
				type: 'speak',
				refs: [OTHER],
				text: 'Meanwhile, checkout, main said: tests pass.',
			}),
		]);
		expect(played.state.meanwhile).toEqual([]);
	});

	it('waiting on the developer (blocked) is not working on their question → lapses at the minute', () => {
		const talking = runAt([[10, said(OTHER)]], onScreen());
		const lapsed = runAt(
			[
				[11, { type: 'turn_started', ref: OTHER }],
				[
					12,
					{
						type: 'ask_opened',
						ask: { id: 'p1', ref: OTHER, at: 12, kind: 'plan', input: {}, plan: 'x' },
					},
				],
				[EXCHANGE_IDLE_MS + 10, { type: 'exchange_expired', ref: OTHER, lastAt: 10 }],
			],
			talking,
		);

		expect(lapsed.sessions[OTHER]?.status).toBe('blocked');
		expect(lapsed.exchange).toBeNull();
	});

	it('still at work on it → kept, but never past ten minutes since the developer spoke to it', () => {
		const talking = runAt(
			[
				[10, said(OTHER)],
				[11, { type: 'turn_started', ref: OTHER }],
			],
			onScreen(),
		);
		const early = runAt(
			[[EXCHANGE_IDLE_MS + 10, { type: 'exchange_expired', ref: OTHER, lastAt: 10 }]],
			talking,
		);
		const late = runAt(
			[[EXCHANGE_WORK_MS + 10, { type: 'exchange_expired', ref: OTHER, lastAt: 10 }]],
			talking,
		);

		expect(early.exchange?.ref).toBe(OTHER);
		expect(late.exchange).toBeNull();
	});
});

describe('what goes when sessions go', () => {
	it('a question about a session that is gone → gone with it', () => {
		const asked = runAt(
			[
				[10, { type: 'offer_switch', ref: OTHER }],
				[11, { type: 'ask_target', ref: OTHER, screen: SCREEN, text: 'review it' }],
				// Its worker gone too: a running one stays until it exits.
				[11.5, { type: 'worker_exited', ref: OTHER, error: null }],
			],
			onScreen(),
		);
		const removed = runAt(
			[[12, { type: 'worktrees', worktrees: [worktree(SCREEN), worktree('signals/main')] }]],
			asked,
		);

		expect(asked.targetAsk?.ref).toBe(OTHER);
		expect(removed.switchOffer).toBeNull();
		expect(removed.targetAsk).toBeNull();
	});

	it('a worktree removed → its conversation, update and history entry go; the others stay', () => {
		const state = runAt(
			[
				[11, { type: 'meanwhile_added', ref: OTHER, kind: 'done', about: 'the retries' }],
				[13, { type: 'switch_view', view: { kind: 'session', ref: OTHER } }],
				[14, { type: 'switch_view', view: { kind: 'session', ref: SCREEN } }],
				// After the switches: going to a session settles its own waiting update.
				[14.5, { type: 'meanwhile_added', ref: SCREEN, kind: 'done', about: 'the locale' }],
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
