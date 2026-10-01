import { describe, expect, it } from 'bun:test';
import { SWITCH_OFFER_MS, type Input, type State } from '../shared/protocol.js';
import { createInitialState, reduce, type ReducerResult } from './reducer.js';
import { worktree } from '../../test/support/reduce.js';
import { createFixtureState } from '../../test/support/state.js';

const SCREEN = 'store/main';
const OTHER = 'checkout/main';

// Inputs at the times given, so lapses can be tested.
const runAt = (steps: [number, Input][], start: State): State =>
	steps.reduce((state, [at, input]) => {
		const seq = state.seq + 1;

		return reduce(state, { seq, at, id: `i${seq}`, input }).state;
	}, start);

const reduceAt = (state: State, at: number, input: Input): ReducerResult => {
	const seq = state.seq + 1;

	return reduce(state, { seq, at, id: `i${seq}`, input });
};

const spokenTexts = (result: ReducerResult): string[] =>
	result.effects.flatMap((effect) => (effect.type === 'speak' ? [effect.text] : []));

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
			[2.5, { type: 'activate', ref: SCREEN }],
			[2.6, { type: 'session_started', ref: SCREEN }],
			[3, { type: 'activate', ref: OTHER }],
			[4, { type: 'session_started', ref: OTHER } as Input],
		],
		createInitialState(),
	);

const said = (ref: string, saidOn?: string): Input => ({
	type: 'send',
	ref,
	text: 'is the build green?',
	isSpoken: true,
	...(saidOn ? { saidOn } : {}),
});

const openPermission = (ref: string): Input => ({
	type: 'ask_opened',
	ask: {
		id: `p-${ref}`,
		ref,
		at: 5,
		kind: 'permission',
		toolName: 'Bash',
		summary: 'run git push',
		input: {},
		suggestions: [],
	},
});

describe('words sent to a session not on screen', () => {
	it('spoken → "Sent to …. Switch there?", one line, and the offer opens', () => {
		const result = reduceAt(onScreen(), 10, said(OTHER));

		expect(spokenTexts(result)).toEqual(['Sent to checkout, main. Switch there?']);
		expect(result.effects).toContainEqual(
			expect.objectContaining({ type: 'speak', ref: OTHER, isAsking: true }),
		);
		expect(result.state.switchOffer).toEqual({ ref: OTHER, at: 10 });
	});

	it('to the session on screen → nothing said, nothing offered: it answers for itself', () => {
		const result = reduceAt(onScreen(), 10, said(SCREEN));

		expect(spokenTexts(result)).toEqual([]);
		expect(result.state.switchOffer).toBeNull();
	});

	it('said on its screen, then clicked away before the words went → left: no ack, no offer', () => {
		const away = runAt(
			[[20, { type: 'switch_view', view: { kind: 'session', ref: OTHER } }]],
			onScreen(),
		);
		const result = reduceAt(away, 30, said(SCREEN, SCREEN));

		expect(spokenTexts(result)).toEqual([]);
		expect(result.state.switchOffer).toBeNull();
	});

	it('typed → only "Sent to": nobody is listening for a question', () => {
		const result = reduceAt(onScreen(), 10, { type: 'send', ref: OTHER, text: 'hi' });

		expect(spokenTexts(result)).toEqual(['Sent to checkout, main.']);
		expect(result.state.switchOffer).toBeNull();
	});

	it('on Mission Control → nothing said: the kernel says where the words went', () => {
		const home = runAt([[5, { type: 'switch_view', view: { kind: 'grid' } }]], onScreen());
		const result = reduceAt(home, 10, said(OTHER));

		expect(spokenTexts(result)).toEqual([]);
		expect(result.state.switchOffer).toBeNull();
	});

	it("another session's open question → still offered: it only waits on its own", () => {
		const another = reduceAt(
			runAt([[5, openPermission('signals/main')]], onScreen()),
			10,
			said(OTHER),
		);

		expect(another.state.switchOffer?.ref).toBe(OTHER);
	});

	it('an offer still open → not asked over; a lapsed one left in state → asked', () => {
		const open: State = { ...onScreen(), switchOffer: { ref: 'signals/main', at: 8 } };
		const lapsed: State = {
			...onScreen(),
			switchOffer: { ref: 'signals/main', at: -100_000, heardAt: -99_000 },
		};

		expect(reduceAt(open, 10, said(OTHER)).state.switchOffer?.ref).toBe('signals/main');
		expect(reduceAt(lapsed, 10, said(OTHER)).state.switchOffer?.ref).toBe(OTHER);
	});

	it('a session on a machine out of reach → the words wait for it, and no switch is offered', () => {
		const REMOTE = 'vm1:crew/main';
		const start = runAt(
			[
				[1, { type: 'machines', machines: [{ id: 'vm1', host: 'vm1', name: 'Build box' }] }],
				[2, { type: 'worktrees', worktrees: [worktree(SCREEN), worktree(REMOTE)] }],
				[3, { type: 'switch_view', view: { kind: 'session', ref: SCREEN } }],
			],
			createInitialState(),
		);
		const replied = reduceAt(start, 13, {
			type: 'send',
			ref: REMOTE,
			text: 'push it',
			isSpoken: true,
		});

		expect(replied.state.switchOffer).toBeNull();
		expect(spokenTexts(replied)).toEqual([
			"Build box is out of reach. I'll send it when it's back.",
		]);
	});
});

describe('the switch offer', () => {
	const offered = (): State => runAt([[40, { type: 'offer_switch', ref: OTHER }]], onScreen());

	it('asked aloud as "Switch to …?"', () => {
		const result = reduceAt(onScreen(), 10, { type: 'offer_switch', ref: OTHER });

		expect(result.state.switchOffer).toEqual({ ref: OTHER, at: 10 });
		expect(spokenTexts(result)).toEqual(['Switch to checkout, main?']);
	});

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
			runAt([[55 + SWITCH_OFFER_MS, { type: 'switch_offer_closed', at: 40, isLapse: true }]], heard)
				.switchOffer,
		).toBeNull();
	});
});

describe('the activate and deactivate offers', () => {
	const PERSONAL_SETUP = 'personal:setup';
	const withPersonal = (view?: string): State =>
		createFixtureState({
			machine: { id: 'personal', name: 'Personal', refs: [PERSONAL_SETUP, 'personal:crew/main'] },
			inactive: ['store-front/wrk1', PERSONAL_SETUP],
			...(view ? { view } : {}),
		});

	it('activate → "<X> isn\'t active. Activate it?", an ack', () => {
		const result = reduceAt(withPersonal(), 10, {
			type: 'offer_switch',
			ref: 'store-front/wrk1',
			kind: 'activate',
		});

		expect(result.state.switchOffer).toEqual({ ref: 'store-front/wrk1', at: 10, kind: 'activate' });
		expect(result.effects).toEqual([
			expect.objectContaining({
				type: 'speak',
				text: "store front, work 1 isn't active. Activate it?",
				isAck: true,
				isAsking: true,
				ref: 'store-front/wrk1',
			}),
		]);
	});

	it('activate asked for a switch → thenSwitch kept for the yes', () => {
		const result = reduceAt(withPersonal(), 10, {
			type: 'offer_switch',
			ref: 'store-front/wrk1',
			kind: 'activate',
			thenSwitch: true,
		});

		expect(result.state.switchOffer).toEqual({
			ref: 'store-front/wrk1',
			at: 10,
			kind: 'activate',
			thenSwitch: true,
		});
	});

	it("a remote's setup → \"Personal's setup isn't active. Activate it?\", even inside Personal", () => {
		for (const view of [undefined, 'personal:crew/main']) {
			const result = reduceAt(withPersonal(view), 10, {
				type: 'offer_switch',
				ref: PERSONAL_SETUP,
				kind: 'activate',
			});

			expect(spokenTexts(result)).toEqual(["Personal's setup isn't active. Activate it?"]);
		}
	});

	it('deactivate → "<X> is working. Deactivate anyway?"', () => {
		const result = reduceAt(withPersonal(), 10, {
			type: 'offer_switch',
			ref: 'store-front/main',
			kind: 'deactivate',
		});

		expect(result.state.switchOffer).toEqual({
			ref: 'store-front/main',
			at: 10,
			kind: 'deactivate',
		});
		expect(spokenTexts(result)).toEqual(['store front, main is working. Deactivate anyway?']);
	});

	it('a fresh switch offer open → replaced: it answers what was just asked', () => {
		const open: State = { ...withPersonal(), switchOffer: { ref: 'checkout-api/main', at: 9 } };
		const result = reduceAt(open, 10, {
			type: 'offer_switch',
			ref: 'store-front/wrk1',
			kind: 'activate',
		});
		const plain = reduceAt(open, 10, { type: 'offer_switch', ref: 'store-front/wrk1' });

		expect(result.state.switchOffer).toMatchObject({ ref: 'store-front/wrk1', kind: 'activate' });
		expect(plain.state.switchOffer?.ref).toBe('checkout-api/main');
	});
});

describe('the meanwhile line', () => {
	const waitingFor = (...refs: string[]): State =>
		runAt(
			refs.map((ref, index): [number, Input] => [
				10 + index / 10,
				{ type: 'meanwhile_added', ref, kind: 'done', about: 'tests pass' },
			]),
			runAt(
				[
					[
						0.5,
						{
							type: 'worktrees',
							worktrees: [
								worktree(SCREEN),
								worktree(OTHER),
								worktree('signals/main'),
								worktree('admin/main'),
							],
						},
					],
					[0.6, { type: 'activate', ref: 'signals/main' }],
					[0.7, { type: 'activate', ref: 'admin/main' }],
				],
				onScreen(),
			),
		);

	it('one session → it ends "Switch there?" and opens the offer for it', () => {
		const played = reduceAt(waitingFor(OTHER), 20, { type: 'play_meanwhile' });

		expect(played.effects).toEqual([
			expect.objectContaining({
				type: 'speak',
				text: 'Meanwhile, checkout, main said: tests pass. Switch there?',
				ref: OTHER,
				refs: [OTHER],
				isAsking: true,
				isUpdate: true,
			}),
		]);
		expect(played.state.switchOffer).toEqual({ ref: OTHER, at: 20 });
	});

	it('heard → the offer counts from then', () => {
		const played = reduceAt(waitingFor(OTHER), 20, { type: 'play_meanwhile' }).state;
		const said = runAt(
			[
				[
					21,
					{
						type: 'spoken',
						text: 'Meanwhile, checkout, main said: tests pass. Switch there?',
						source: 'narrator',
						ref: OTHER,
						isAsking: true,
						isUpdate: true,
						refs: [OTHER],
					},
				],
			],
			played,
		);
		const lineId = said.spoken.at(-1)?.id ?? '';
		const heard = runAt([[30, { type: 'spoken_ended', lineId, isCut: false }]], said);

		expect(heard.switchOffer).toEqual({ ref: OTHER, at: 20, heardAt: 30 });
	});

	it('two sessions → names only: a yes could mean either', () => {
		const played = reduceAt(waitingFor(OTHER, 'signals/main'), 20, { type: 'play_meanwhile' });

		expect(played.effects).toEqual([
			expect.not.objectContaining({ isAsking: true, ref: expect.anything() }),
		]);
		expect(spokenTexts(played)[0]).not.toContain('Switch there?');
		expect(played.state.switchOffer).toBeNull();
	});

	it('an offer still open → not asked over', () => {
		const open: State = { ...waitingFor(OTHER), switchOffer: { ref: 'signals/main', at: 19 } };
		const played = reduceAt(open, 20, { type: 'play_meanwhile' });

		expect(spokenTexts(played)[0]).not.toContain('Switch there?');
		expect(played.state.switchOffer?.ref).toBe('signals/main');
	});

	it('a question said in full → no offer: the yes answers the question, where they are', () => {
		const asking = runAt(
			[
				[5, openPermission(OTHER)],
				[
					6,
					{ type: 'meanwhile_added', ref: OTHER, kind: 'needs', about: null, askId: `p-${OTHER}` },
				],
			],
			onScreen(),
		);
		const played = reduceAt(asking, 20, { type: 'play_meanwhile' });

		expect(played.effects).toEqual([
			expect.objectContaining({ toldAsks: [{ ref: OTHER, askId: `p-${OTHER}` }] }),
		]);
		expect(spokenTexts(played)[0]).not.toContain('Switch there?');
		expect(played.state.switchOffer).toBeNull();
	});

	it('the session on screen is left out of the meanwhile line', () => {
		const waiting = runAt(
			[
				[10, { type: 'meanwhile_added', ref: SCREEN, kind: 'done', about: 'locale done' }],
				[11, { type: 'meanwhile_added', ref: OTHER, kind: 'done', about: 'tests pass' }],
			],
			onScreen(),
		);
		const played = reduceAt(waiting, 20, { type: 'play_meanwhile' });

		expect(played.effects).toEqual([
			expect.objectContaining({
				type: 'speak',
				refs: [OTHER],
				text: 'Meanwhile, checkout, main said: tests pass. Switch there?',
			}),
		]);
		expect(played.state.meanwhile).toEqual([]);
	});

	it('names at most two sessions; one it only counted is not among its refs', () => {
		const played = reduceAt(waitingFor(OTHER, 'signals/main', 'admin/main'), 20, {
			type: 'play_meanwhile',
		});

		expect(played.effects).toEqual([expect.objectContaining({ refs: [OTHER, 'signals/main'] })]);
		expect(played.state.switchOffer).toBeNull();
	});

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

describe('what goes when sessions go', () => {
	it('a question about a session that is gone → gone with it', () => {
		const asked = runAt(
			[
				[10, { type: 'offer_switch', ref: OTHER }],
				[11, { type: 'ask_which', ref: OTHER, screen: SCREEN, text: 'review it' }],
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

	it('a worktree removed → its update and history entry go; the others stay', () => {
		const state = runAt(
			[
				[11, { type: 'meanwhile_added', ref: OTHER, kind: 'done', about: 'the retries' }],
				[13, { type: 'switch_view', view: { kind: 'session', ref: OTHER } }],
				[14, { type: 'switch_view', view: { kind: 'session', ref: SCREEN } }],
				// After the switches: going to a session settles its own waiting update.
				[14.5, { type: 'meanwhile_added', ref: SCREEN, kind: 'done', about: 'the locale' }],
				[15, { type: 'meanwhile_added', ref: OTHER, kind: 'done', about: 'more retries' }],
				[16, { type: 'worker_exited', ref: OTHER, error: null }],
			],
			onScreen(),
		);
		const removed = runAt(
			[[17, { type: 'worktrees', worktrees: [worktree(SCREEN), worktree('signals/main')] }]],
			state,
		);

		expect(removed.meanwhile.map((item) => item.ref)).toEqual([SCREEN]);
		expect(
			removed.viewHistory.some(({ view }) => view.kind === 'session' && view.ref === OTHER),
		).toBe(false);
	});

	it("a machine removed → its sessions' updates and views go, this Mac's stay", () => {
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

		expect(state.meanwhile).toEqual([]);
		expect(state.switchOffer).toBeNull();
		// Build box's grid and its session are gone; this Mac's session and the start stay.
		expect(state.viewHistory.map(({ view }) => view)).toEqual([
			{ kind: 'session', ref: SCREEN },
			{ kind: 'machines' },
		]);
	});
});
