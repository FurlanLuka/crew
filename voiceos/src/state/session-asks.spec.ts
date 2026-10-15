import { describe, expect, it } from 'bun:test';
import { run, worktree } from '../../test/support/reduce.js';
import type { Input, QueuedMessage, State } from '../shared/protocol.js';
import { buildPeerNote } from '../shared/peer-note.js';
import type { Effect } from './reducer.js';
import { isDevelopersMessage, promoteAllQueued } from './delivery.js';
import { updateSession } from './helpers.js';
import { NOT_DELIVERED } from './peer-cards.js';
import { SUBAGENT_ITEMS_KEPT } from './subagents.js';
import { PEER_REQUESTS_PER_TURN, resolveAskTarget } from './session-asks.js';

const STORE = 'store-front/main';
const CHECKOUT = 'checkout-api/main';
const REMOTE_CHECKOUT = 'vm1:checkout-api/main';
const REMOTE_STORE = 'vm1:store-front/wrk2';

// Four active sessions on two machines, all idle.
const sessions = (): State =>
	run([
		{ type: 'machines', machines: [{ id: 'vm1', host: 'dev@vm1', name: 'Build box' }] },
		{
			type: 'worktrees',
			worktrees: [
				worktree(STORE),
				worktree(CHECKOUT),
				worktree(REMOTE_CHECKOUT),
				worktree(REMOTE_STORE),
			],
		},
		...[STORE, CHECKOUT, REMOTE_CHECKOUT, REMOTE_STORE].flatMap((ref): Input[] => [
			{ type: 'activate', ref },
			{ type: 'session_started', ref },
		]),
	]).state;

const updateQueue = (state: State, ref: string, message: QueuedMessage): State =>
	updateSession(state, ref, (session) => ({ ...session, queue: [...session.queue, message] }));

const busy = (state: State, ref: string): State =>
	run([{ type: 'send', ref, text: 'keep working' }], { start: state }).state;

const request = (
	kind: 'ask' | 'tell' | 'secret',
	text: string,
	{
		ref = STORE,
		session = 'checkout',
		id = 'r1',
	}: { ref?: string; session?: string; id?: string } = {},
): Input => ({ type: 'session_ask_requested', ref, id, kind, session, text, files: [] });

const answered = (effects: Effect[]) =>
	effects.flatMap((effect) => (effect.type === 'session_ask_answered' ? [effect.text] : []));
const cardsOf = (state: State, ref: string) =>
	(state.sessions[ref]?.stream ?? []).filter((item) => item.kind === 'session_ask');

describe('resolveAskTarget', () => {
	it("a name on the asker's own machine and on another → the asker's", () => {
		const state = sessions();

		expect(resolveAskTarget(state, STORE, 'checkout api main')).toEqual({
			kind: 'one',
			ref: CHECKOUT,
		});
		expect(resolveAskTarget(state, REMOTE_STORE, 'checkout api main')).toEqual({
			kind: 'one',
			ref: REMOTE_CHECKOUT,
		});
	});

	it('the full ref → that session, whatever machine', () =>
		expect(resolveAskTarget(sessions(), STORE, REMOTE_CHECKOUT)).toEqual({
			kind: 'one',
			ref: REMOTE_CHECKOUT,
		}));

	it('unknown → refused with the sessions it could mean', () => {
		const refused = resolveAskTarget(sessions(), STORE, 'billing');

		expect(refused.kind).toBe('refused');
		expect(refused.kind === 'refused' && refused.reason).toContain(
			'No active session is called "billing"',
		);
		expect(refused.kind === 'refused' && refused.reason).toContain(`(${REMOTE_CHECKOUT})`);
	});

	it('itself → refused', () =>
		expect(resolveAskTarget(sessions(), STORE, STORE)).toEqual({
			kind: 'refused',
			reason: 'That is you: ask another session.',
		}));
});

describe('an ask', () => {
	it('→ a card on the asker, a side-panel run on the asked session (no card there), and a copy of it is run', () => {
		const { state, effects } = run(
			[request('ask', 'Which retry limit?', { session: 'checkout api main' })],
			{
				start: sessions(),
			},
		);

		expect(effects).toContainEqual({
			type: 'session_fork',
			ref: CHECKOUT,
			id: 'r1',
			fromLabel: STORE,
			question: 'Which retry limit?',
		});
		expect(cardsOf(state, STORE)).toMatchObject([
			{ peer: CHECKOUT, peerRef: CHECKOUT, status: 'asking' },
		]);
		expect(cardsOf(state, CHECKOUT)).toEqual([]);
		expect(state.sessions[CHECKOUT]?.peerRuns).toMatchObject([
			{
				requestId: 'r1',
				kind: 'ask',
				fromRef: STORE,
				fromLabel: STORE,
				text: 'Which retry limit?',
				status: 'asking',
				settledAt: null,
				items: [],
			},
		]);
		expect(state.sessions[STORE]?.peerRequestsInTurn).toBe(1);
	});

	it('answered → the card and the run settle and the asker hears the answer once; a late repeat is ignored', () => {
		const asked = run([request('ask', 'Which retry limit?', { session: 'checkout api main' })], {
			start: sessions(),
		}).state;
		const settled: Input = {
			type: 'session_fork_settled',
			ref: CHECKOUT,
			id: 'r1',
			status: 'answered',
			answer: 'Five tries.',
			files: [],
			read: ['src/retry.ts'],
		};
		const { state, effects } = run([settled], { start: asked });

		expect(answered(effects)).toEqual([`${CHECKOUT} answered:\n\nFive tries.`]);
		expect(cardsOf(state, STORE)).toMatchObject([
			{ status: 'answered', answer: 'Five tries.', read: ['src/retry.ts'], settledAt: 1000 },
		]);
		expect(state.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({
			status: 'answered',
			answer: 'Five tries.',
			step: null,
			settledAt: 1000,
		});
		expect(answered(run([settled], { start: state }).effects)).toEqual([]);
	});

	it('no answer in time → failed, and the asker is told', () => {
		const asked = run([request('ask', 'q', { session: 'checkout api main' })], {
			start: sessions(),
		}).state;
		const { state, effects } = run([{ type: 'peer_expired', key: 'r1' }], { start: asked });

		expect(answered(effects)).toEqual([`No answer from ${CHECKOUT} in time.`]);
		expect(cardsOf(state, STORE)).toMatchObject([{ status: 'failed' }]);
	});

	it(`more than ${PEER_REQUESTS_PER_TURN} in one turn → the next is refused, no copy runs`, () => {
		const start = run(
			[1, 2, 3].map((n) => request('ask', 'q', { session: 'checkout api main', id: `r${n}` })),
			{ start: sessions() },
		).state;
		const { effects } = run([request('ask', 'q', { session: 'checkout api main', id: 'r4' })], {
			start,
		});

		expect(effects.some((effect) => effect.type === 'session_fork')).toBe(false);
		expect(answered(effects)[0]).toContain('You already made 3 requests');
	});
});

describe('work an ask would need', () => {
	const needsWork = (): State => {
		const asked = run(
			[request('ask', 'Does /orders work on staging?', { session: 'checkout api main' })],
			{
				start: sessions(),
			},
		).state;

		return run(
			[
				{
					type: 'session_fork_settled',
					ref: CHECKOUT,
					id: 'r1',
					status: 'needs_work',
					answer: 'run the staging check for /orders',
					files: [],
					read: [],
				},
			],
			{ start: asked },
		).state;
	};

	it('→ the developer is asked out loud, docked on the asker', () => {
		const state = needsWork();

		expect(state.asks).toMatchObject([
			{
				id: 'r1:ok',
				ref: STORE,
				kind: 'work',
				to: CHECKOUT,
				text: 'run the staging check for /orders',
			},
		]);
	});

	it("allowed → the work goes to the asked session as the asker's, and its reply goes back", () => {
		const allowed = run([{ type: 'answer_peer', askId: 'r1:ok', isApproved: true }], {
			start: needsWork(),
		});
		const turn = allowed.state.sessions[CHECKOUT];

		expect(allowed.state.asks).toEqual([]);
		expect(turn?.replyOwed).toBe(STORE);
		expect(turn?.stream.at(-1)).toMatchObject({ kind: 'user', from: STORE });

		const ended = run(
			[{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'Staging returns 200.' }],
			{ start: allowed.state },
		).state;

		expect(ended.sessions[STORE]?.stream.at(-1)).toMatchObject({
			kind: 'user',
			from: CHECKOUT,
			text: `${CHECKOUT} finished the work you asked for. Its reply:\n\nStaging returns 200.`,
		});
	});

	it('refused, or nobody answers → closed; nothing reaches either session', () => {
		for (const input of [
			{ type: 'answer_peer', askId: 'r1:ok', isApproved: false },
			{ type: 'peer_expired', key: 'r1:ok' },
		] as Input[]) {
			const { state } = run([input], { start: needsWork() });

			expect(state.asks).toEqual([]);
			expect(state.sessions[CHECKOUT]?.queue).toEqual([]);
			expect(cardsOf(state, STORE)[0]).toMatchObject({ status: 'refused' });
		}
	});
});

describe('a tell', () => {
	it('to a busy session → queued as information from the sender, never as the developer', () => {
		const { state, effects } = run(
			[request('tell', 'orders gained refunded_at', { session: 'checkout api main' })],
			{ start: busy(sessions(), CHECKOUT) },
		);
		const [queued] = state.sessions[CHECKOUT]?.queue ?? [];

		expect(answered(effects)).toEqual([`Queued for ${CHECKOUT} after its current work.`]);
		expect(queued).toMatchObject({
			text: 'orders gained refunded_at',
			note: buildPeerNote(STORE),
			from: { ref: STORE, label: STORE },
		});
		expect(queued && isDevelopersMessage(queued)).toBe(false);
	});

	it("never merged into the developer's own queued words", () => {
		const start = run(
			[
				{ type: 'send', ref: CHECKOUT, text: 'also run the linter' },
				request('tell', 'orders gained refunded_at', { session: 'checkout api main' }),
				{ type: 'send', ref: CHECKOUT, text: 'and push' },
			],
			{ start: busy(sessions(), CHECKOUT) },
		).state;
		const merged = promoteAllQueued({
			state: start,
			ref: CHECKOUT,
			stamped: {
				seq: 99,
				at: 9_999,
				id: 'p',
				input: { type: 'promote_all_queued', ref: CHECKOUT },
			},
		}).state;

		const texts = merged.sessions[CHECKOUT]?.queue.map((message) => message.text) ?? [];

		expect(texts).toContain('orders gained refunded_at');
		expect(texts).toContain('also run the linter\n\nand push');
	});

	it('back to the session whose message started this turn → refused', () => {
		const told = run([request('tell', 'fyi', { ref: CHECKOUT, session: 'store front main' })], {
			start: sessions(),
		}).state;

		expect(told.sessions[STORE]?.turnFrom).toBe(CHECKOUT);
		expect(
			answered(
				run([request('tell', 'thanks', { id: 'r2', session: 'checkout api main' })], {
					start: told,
				}).effects,
			)[0],
		).toContain('This turn started with a message from that session');
	});
});

describe('a secret', () => {
	const requested = () =>
		run([request('secret', 'STRIPE_KEY', { session: 'checkout api main' })], { start: sessions() });

	it('→ never read until the developer allows it; the asker is told to wait for a message', () => {
		const { state, effects } = requested();

		expect(state.asks).toMatchObject([
			{ kind: 'secret', what: 'STRIPE_KEY', to: CHECKOUT, ref: STORE },
		]);
		expect(effects.some((effect) => effect.type === 'secret_transfer')).toBe(false);
		expect(answered(effects)[0]).toContain('Asked the developer to allow copying STRIPE_KEY');
	});

	it('allowed → copied by the machine that has it; the path, never the value, reaches the asker', () => {
		const allowed = run([{ type: 'answer_peer', askId: 'r1:ok', isApproved: true }], {
			start: requested().state,
		});

		expect(allowed.effects).toContainEqual({
			type: 'secret_transfer',
			ref: CHECKOUT,
			id: 'r1',
			what: 'STRIPE_KEY',
			toRef: STORE,
		});

		const copied = run(
			[
				{
					type: 'secret_transferred',
					ref: STORE,
					id: 'r1',
					path: '/s/store-front_main/r1/STRIPE_KEY.env',
				},
			],
			{ start: allowed.state },
		).state;

		// Told by Voice OS, never as words of the asked session.
		expect(copied.sessions[STORE]?.stream.at(-1)).toMatchObject({
			kind: 'user',
			from: 'Voice OS',
		});
		expect(JSON.stringify(copied.sessions[STORE]?.stream.at(-1))).toContain(
			'/s/store-front_main/r1/STRIPE_KEY.env',
		);
		expect(cardsOf(copied, STORE)[0]).toMatchObject({
			status: 'answered',
			answer: '/s/store-front_main/r1/STRIPE_KEY.env',
		});
		expect(copied.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({
			kind: 'secret',
			text: 'STRIPE_KEY',
			status: 'answered',
			answer: null,
		});
	});
});

describe('what keeps it tidy', () => {
	const needsWork = (): State => {
		const asked = run(
			[request('ask', 'Does it work on staging?', { session: 'checkout api main' })],
			{
				start: sessions(),
			},
		);

		return run(
			[
				{
					type: 'session_fork_settled',
					ref: CHECKOUT,
					id: 'r1',
					status: 'needs_work',
					answer: 'run the staging check',
					files: [],
					read: [],
				},
			],
			{ start: asked.state },
		).state;
	};

	const allowed = (): State =>
		run([{ type: 'answer_peer', askId: 'r1:ok', isApproved: true }], { start: needsWork() }).state;

	it('every wait has its timer: the copy 200 s, the Allow 15 min, a secret after Allow 200 s', () => {
		const asked = run([request('ask', 'q', { session: 'checkout api main' })], {
			start: sessions(),
		});
		const opened = run(
			[
				{
					type: 'session_fork_settled',
					ref: CHECKOUT,
					id: 'r1',
					status: 'needs_work',
					answer: 'x',
					files: [],
					read: [],
				},
			],
			{ start: asked.state },
		);
		const secret = run(
			[request('secret', 'STRIPE_KEY', { session: 'checkout api main', id: 's1' })],
			{
				start: sessions(),
			},
		);
		const secretAllowed = run([{ type: 'answer_peer', askId: 's1:ok', isApproved: true }], {
			start: secret.state,
		});

		expect(asked.effects).toContainEqual({ type: 'expire_peer', key: 'r1', ms: 200_000 });
		expect(opened.effects).toContainEqual({ type: 'expire_peer', key: 'r1:ok', ms: 900_000 });
		expect(opened.effects).toContainEqual(
			expect.objectContaining({ type: 'speak', source: 'alert', isAsking: true }),
		);
		expect(secret.effects).toContainEqual({ type: 'expire_peer', key: 's1:ok', ms: 900_000 });
		expect(secretAllowed.effects).toContainEqual({ type: 'expire_peer', key: 's1', ms: 200_000 });
	});

	it('the asker interrupted, or its worker gone → the Allow still waits; its lapse clears the request', () => {
		const secret = run([request('secret', 'STRIPE_KEY', { session: 'checkout api main' })], {
			start: sessions(),
		}).state;
		const interrupted = run([{ type: 'interrupt', ref: STORE }], { start: secret }).state;
		const exited = run([{ type: 'worker_exited', ref: STORE, error: null }], {
			start: interrupted,
		}).state;

		expect(exited.asks).toMatchObject([{ id: 'r1:ok', kind: 'secret' }]);

		const lapsed = run([{ type: 'peer_expired', key: 'r1:ok' }], { start: exited }).state;

		expect(lapsed.asks).toEqual([]);
		expect(lapsed.peerRequests).toEqual([]);
		expect(cardsOf(lapsed, STORE)[0]).toMatchObject({ status: 'refused' });
	});

	it('an Allow whose ask went first (its machine removed) → its lapse still clears the request', () => {
		const secret = run([request('secret', 'STRIPE_KEY', { session: 'checkout api main' })], {
			start: sessions(),
		}).state;
		const gone = { ...secret, asks: [] };

		expect(
			run([{ type: 'peer_expired', key: 'r1:ok' }], { start: gone }).state.peerRequests,
		).toEqual([]);
	});

	it('a secret allowed but never copied in time → the asker is told, as it was promised a message', () => {
		const secret = run([request('secret', 'STRIPE_KEY', { session: 'checkout api main' })], {
			start: sessions(),
		}).state;
		const allowedSecret = run([{ type: 'answer_peer', askId: 'r1:ok', isApproved: true }], {
			start: secret,
		}).state;
		const expired = run([{ type: 'peer_expired', key: 'r1' }], { start: allowedSecret }).state;

		expect(expired.sessions[STORE]?.stream.at(-1)).toMatchObject({
			kind: 'user',
			from: 'Voice OS',
			text: `The secret from ${CHECKOUT} could not be copied: no answer in time.`,
		});
		expect(cardsOf(expired, STORE)[0]).toMatchObject({
			status: 'failed',
			answer: 'no answer in time',
		});
		expect(expired.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({ status: 'failed' });
	});

	it('a copy that failed → the asker is told why', () => {
		const secret = run(
			[
				request('secret', 'STRIPE_KEY', { session: 'checkout api main' }),
				{ type: 'answer_peer', askId: 'r1:ok', isApproved: true },
				{
					type: 'secret_transferred',
					ref: CHECKOUT,
					id: 'r1',
					path: null,
					reason: "STRIPE_KEY is not in the session's .env files",
				},
			],
			{ start: sessions() },
		).state;

		expect(secret.sessions[STORE]?.stream.at(-1)).toMatchObject({
			text: `The secret from ${CHECKOUT} could not be copied: STRIPE_KEY is not in the session's .env files.`,
		});
		expect(cardsOf(secret, STORE)[0]).toMatchObject({
			status: 'failed',
			answer: "STRIPE_KEY is not in the session's .env files",
		});
		expect(secret.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({
			status: 'failed',
			answer: "STRIPE_KEY is not in the session's .env files",
		});
	});

	it('the allowed work interrupted → nothing goes back to the asker', () => {
		const stopped = run(
			[
				{ type: 'interrupt', ref: CHECKOUT },
				{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'half done' },
			],
			{ start: allowed() },
		).state;

		expect(stopped.sessions[STORE]?.stream.some((item) => item.kind === 'user' && item.from)).toBe(
			false,
		);
	});

	it("the allowed work cut by the developer's follow-up → the follow-up's turn owes the reply", () => {
		const cut = run(
			[
				{ type: 'send', ref: CHECKOUT, text: 'use the staging token', isNow: true },
				{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'cut short' },
			],
			{ start: allowed() },
		).state;

		expect(cut.sessions[CHECKOUT]?.replyOwed).toBe(STORE);
		expect(cut.sessions[STORE]?.stream.some((item) => item.kind === 'user' && item.from)).toBe(
			false,
		);

		const done = run([{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'All green.' }], {
			start: cut,
		}).state;

		expect(done.sessions[STORE]?.stream.at(-1)).toMatchObject({ from: CHECKOUT });
	});

	it('a turn started by a tell → quiet unless it speaks for itself; the question it waited on stays', () => {
		const waiting = run(
			[{ type: 'narration', ref: CHECKOUT, needsUser: true, text: 'Should I push?' }],
			{ start: sessions() },
		).state;
		const told = run([request('tell', 'fyi: schema changed', { session: 'checkout api main' })], {
			start: waiting,
		}).state;

		expect(told.sessions[CHECKOUT]?.needsUser).not.toBeNull();

		const ended = run([{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'Noted.' }], {
			start: told,
		});

		expect(ended.effects.some((effect) => effect.type === 'narrate')).toBe(false);
	});

	it('a turn started by a tell that ends asking the developer → narrated, so it is heard', () => {
		const told = run([request('tell', 'fyi: schema changed', { session: 'checkout api main' })], {
			start: sessions(),
		}).state;
		const ended = run(
			[
				{
					type: 'turn_ended',
					ref: CHECKOUT,
					costUsd: 0,
					text: 'The schema changed. **Should I migrate now?**',
				},
			],
			{ start: told },
		);

		expect(ended.effects.some((effect) => effect.type === 'narrate')).toBe(true);
	});

	it('a refusal counts for nothing; the count starts over with the next turn', () => {
		const refused = run([request('ask', 'q', { session: 'nobody' })], { start: sessions() }).state;

		expect(refused.sessions[STORE]?.peerRequestsInTurn).toBe(0);

		const counted = run([request('ask', 'q', { session: 'checkout api main', id: 'r2' })], {
			start: busy(refused, STORE),
		}).state;
		const ended = run([{ type: 'turn_ended', ref: STORE, costUsd: 0, text: '' }], {
			start: counted,
		}).state;

		expect(counted.sessions[STORE]?.peerRequestsInTurn).toBe(1);
		expect(ended.sessions[STORE]?.peerRequestsInTurn).toBe(0);
	});
});

describe("the copy's steps on the asked session", () => {
	const asking = (): State =>
		run([request('ask', 'Which retry limit?', { session: 'checkout api main' })], {
			start: sessions(),
		}).state;
	const item = (summary: string): Input => ({
		type: 'session_fork_item',
		ref: CHECKOUT,
		id: 'r1',
		item: { kind: 'tool', name: 'Grep', summary },
	});

	it('each step joins its run; a call is the live step', () => {
		const state = run(
			[
				{
					type: 'session_fork_item',
					ref: CHECKOUT,
					id: 'r1',
					item: { kind: 'text', text: 'Looking.' },
				},
				item('search for MAX_RETRIES'),
			],
			{ start: asking() },
		).state;

		expect(state.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({
			step: 'search for MAX_RETRIES',
			items: [
				{ kind: 'text', text: 'Looking.' },
				{ kind: 'tool', summary: 'search for MAX_RETRIES' },
			],
		});
	});

	it('a step for an unknown request, or after its run settled (late, or the main restarted) → nothing', () => {
		const start = asking();

		expect(run([{ ...item('x'), id: 'r9' } as Input], { start }).state.sessions[CHECKOUT]).toBe(
			start.sessions[CHECKOUT],
		);

		const expired = run([{ type: 'peer_expired', key: 'r1' }], { start }).state;

		expect(expired.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({
			status: 'failed',
			settledAt: 1000,
		});
		expect(
			run([item('late')], { start: expired }).state.sessions[CHECKOUT]?.peerRuns[0]?.items,
		).toEqual([]);
	});

	it(`past ${SUBAGENT_ITEMS_KEPT} steps → the newest kept; a text after a call keeps the call as the step`, () => {
		const many = Array.from(
			{ length: SUBAGENT_ITEMS_KEPT + 5 },
			(_, n): Input => item(`step ${n}`),
		);
		const state = run(
			[
				...many,
				{ type: 'session_fork_item', ref: CHECKOUT, id: 'r1', item: { kind: 'text', text: 'hm' } },
			],
			{ start: asking() },
		).state;
		const peerRun = state.sessions[CHECKOUT]?.peerRuns[0];

		expect(peerRun?.items).toHaveLength(SUBAGENT_ITEMS_KEPT);
		expect(peerRun?.items[0]).toMatchObject({ summary: 'step 6' });
		expect(peerRun?.step).toBe(`step ${SUBAGENT_ITEMS_KEPT + 4}`);
	});

	it("work the copy needed, its asker's machine removed before anyone allowed it → the row ends when the OK lapses", () => {
		const needsWork = run(
			[
				request('ask', 'Does it work on staging?', { ref: REMOTE_STORE, session: CHECKOUT }),
				{
					type: 'session_fork_settled',
					ref: CHECKOUT,
					id: 'r1',
					status: 'needs_work',
					answer: 'run the staging check',
					files: [],
					read: [],
				},
				{ type: 'remove_machine', id: 'vm1' },
			],
			{ start: sessions() },
		).state;

		expect(needsWork.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({
			status: 'needs_work',
			settledAt: null,
		});

		const lapsed = run([{ type: 'peer_expired', key: 'r1:ok' }], { start: needsWork }).state;

		expect(lapsed.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({ status: 'refused' });
		expect(lapsed.sessions[CHECKOUT]?.peerRuns[0]?.settledAt).not.toBeNull();
	});

	it('a remote too old to send steps → the run still settles, with none', () => {
		const state = run(
			[
				{
					type: 'session_fork_settled',
					ref: CHECKOUT,
					id: 'r1',
					status: 'answered',
					answer: 'Five.',
					files: [],
					read: [],
				},
			],
			{ start: asking() },
		).state;

		expect(state.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({ status: 'answered', items: [] });
	});

	it('the asked session restarts or clears its conversation → its runs stay', () => {
		const state = run(
			[
				{ type: 'worker_exited', ref: CHECKOUT, error: null },
				{ type: 'conversation_reset', ref: CHECKOUT },
			],
			{ start: asking() },
		).state;

		expect(state.sessions[CHECKOUT]?.peerRuns).toHaveLength(1);
	});
});

describe('a tell or allowed work, queued → delivered', () => {
	const tell = (start: State): State =>
		run([request('tell', 'totals.grand moves', { session: 'checkout api main' })], { start }).state;

	it('to an idle session → delivered at once, and the words show there from the asker', () => {
		const state = tell(sessions());

		expect(cardsOf(state, STORE)[0]).toMatchObject({ status: 'delivered', peerRef: CHECKOUT });
		expect(state.sessions[CHECKOUT]?.stream.at(-1)).toMatchObject({ kind: 'user', from: STORE });
	});

	it('to a busy one → queued, then delivered when it starts on it', () => {
		const queued = tell(busy(sessions(), CHECKOUT));

		expect(cardsOf(queued, STORE)[0]).toMatchObject({ status: 'queued' });

		const done = run([{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'done' }], {
			start: queued,
		}).state;

		expect(cardsOf(done, STORE)[0]).toMatchObject({ status: 'delivered' });
	});

	it('moved to the front with ▲ now → still from the asker, and delivered when it goes', () => {
		const queued = tell(busy(sessions(), CHECKOUT));
		const queuedId = queued.sessions[CHECKOUT]?.queue[0]?.id ?? '';
		const promoted = run([{ type: 'promote_queued', ref: CHECKOUT, queuedId }], {
			start: queued,
		}).state;

		expect(promoted.sessions[CHECKOUT]?.queue[0]).toMatchObject({
			from: { ref: STORE, requestId: 'r1' },
		});
		expect(cardsOf(promoted, STORE)[0]).toMatchObject({ status: 'queued' });

		const sent = run([{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'cut' }], {
			start: promoted,
		}).state;

		expect(cardsOf(sent, STORE)[0]).toMatchObject({ status: 'delivered' });
		expect(sent.sessions[CHECKOUT]?.stream.at(-1)).toMatchObject({ kind: 'user', from: STORE });
	});

	it("moved to the front, then the developer speaks → the other session's first, theirs right after, apart, and no second interrupt", () => {
		const queued = tell(busy(sessions(), CHECKOUT));
		const queuedId = queued.sessions[CHECKOUT]?.queue[0]?.id ?? '';
		const state = run(
			[
				{ type: 'promote_queued', ref: CHECKOUT, queuedId },
				{ type: 'send', ref: CHECKOUT, text: 'also check the totals', isSpoken: true },
			],
			{ start: queued },
		).state;
		const spoken = run([{ type: 'send', ref: CHECKOUT, text: 'and the tax', isSpoken: true }], {
			start: state,
		});

		expect(spoken.effects.some((effect) => effect.type === 'worker_interrupt')).toBe(false);
		// More words in the burst join theirs, in order.
		expect(spoken.state.sessions[CHECKOUT]?.queue.map((message) => message.text)).toEqual([
			'totals.grand moves',
			'also check the totals and the tax',
		]);
		const queue = state.sessions[CHECKOUT]?.queue ?? [];

		expect(queue.map((message) => message.text)).toEqual([
			'totals.grand moves',
			'also check the totals',
		]);
		expect(queue[0]?.from).toMatchObject({ ref: STORE });
		expect(queue[1]?.from).toBeUndefined();
	});

	it('moved to the front while sub-agents run → folded into the turn as theirs, delivered on that input', () => {
		const queued = run(
			[
				{
					type: 'subagent_started',
					ref: CHECKOUT,
					taskId: 't1',
					agentType: 'Explore',
					description: 'look around',
					isBackground: false,
				},
			],
			{ start: tell(busy(sessions(), CHECKOUT)) },
		).state;
		const queuedId = queued.sessions[CHECKOUT]?.queue[0]?.id ?? '';
		const promoted = run([{ type: 'promote_queued', ref: CHECKOUT, queuedId }], {
			start: queued,
		}).state;

		expect(cardsOf(promoted, STORE)[0]).toMatchObject({ status: 'delivered' });
		expect(promoted.sessions[CHECKOUT]?.stream.at(-1)).toMatchObject({ kind: 'user', from: STORE });
	});

	it('its machine removed → the session goes, and the card says not delivered', () => {
		// Working there: the tell waits in its queue.
		const working = updateSession(sessions(), REMOTE_CHECKOUT, (session) => ({
			...session,
			status: 'running',
		}));
		const queued = run([request('tell', 'heads up', { session: REMOTE_CHECKOUT })], {
			start: working,
		}).state;

		expect(cardsOf(queued, STORE)[0]).toMatchObject({ status: 'queued' });

		const removed = run([{ type: 'remove_machine', id: 'vm1' }], { start: queued }).state;

		expect(cardsOf(removed, STORE)[0]).toMatchObject({ status: 'failed', answer: NOT_DELIVERED });
	});

	it.each<[string, Input[]]>([
		['cancelled', [{ type: 'cancel_queued', ref: CHECKOUT, queuedId: '' }]],
		['interrupted', [{ type: 'interrupt', ref: CHECKOUT }]],
		['the session deactivated', [{ type: 'deactivate', ref: CHECKOUT }]],
		['its worker stopped cleanly', [{ type: 'worker_exited', ref: CHECKOUT, error: null }]],
	])('dropped from the queue (%s) → not delivered', (_how, inputs) => {
		const queued = tell(busy(sessions(), CHECKOUT));
		const queuedId = queued.sessions[CHECKOUT]?.queue[0]?.id ?? '';
		const state = run(
			inputs.map((input) => (input.type === 'cancel_queued' ? { ...input, queuedId } : input)),
			{ start: queued },
		).state;

		expect(cardsOf(state, STORE)[0]).toMatchObject({ status: 'failed', answer: NOT_DELIVERED });
	});

	it('work the developer allowed → queued, then delivered', () => {
		const needsWork = run(
			[
				request('ask', 'Does it work on staging?', { session: 'checkout api main' }),
				{
					type: 'session_fork_settled',
					ref: CHECKOUT,
					id: 'r1',
					status: 'needs_work',
					answer: 'run the staging check',
					files: [],
					read: [],
				},
			],
			{ start: busy(sessions(), CHECKOUT) },
		).state;
		const allowed = run([{ type: 'answer_peer', askId: 'r1:ok', isApproved: true }], {
			start: needsWork,
		}).state;

		expect(cardsOf(allowed, STORE)[0]).toMatchObject({
			status: 'queued',
			answer: 'run the staging check',
		});
		expect(allowed.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({ status: 'queued' });

		const done = run([{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'done' }], {
			start: allowed,
		}).state;

		expect(cardsOf(done, STORE)[0]).toMatchObject({ status: 'delivered' });
	});

	it('allowed work moved to the front → it still reports back to the asker when it ends', () => {
		const allowed = run(
			[
				request('ask', 'Does it work on staging?', { session: 'checkout api main' }),
				{
					type: 'session_fork_settled',
					ref: CHECKOUT,
					id: 'r1',
					status: 'needs_work',
					answer: 'run the staging check',
					files: [],
					read: [],
				},
				{ type: 'answer_peer', askId: 'r1:ok', isApproved: true },
			],
			{ start: busy(sessions(), CHECKOUT) },
		).state;
		const queuedId = allowed.sessions[CHECKOUT]?.queue[0]?.id ?? '';
		const done = run(
			[
				{ type: 'promote_queued', ref: CHECKOUT, queuedId },
				{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'cut' },
				{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'All green.' },
			],
			{ start: allowed },
		).state;

		expect(done.sessions[STORE]?.stream.at(-1)).toMatchObject({ kind: 'user', from: CHECKOUT });
		expect(JSON.stringify(done.sessions[STORE]?.stream.at(-1))).toContain('All green.');
	});

	it('a peer message queued without a request (from before this change) → delivered, no card touched', () => {
		const start = updateQueue(tell(busy(sessions(), CHECKOUT)), CHECKOUT, {
			id: 'legacy',
			text: 'old words',
			at: 1,
			from: { ref: STORE, label: STORE },
		});
		const state = run(
			[
				{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'done' },
				{ type: 'turn_ended', ref: CHECKOUT, costUsd: 0, text: 'done' },
			],
			{ start },
		).state;

		expect(state.sessions[CHECKOUT]?.stream.at(-1)).toMatchObject({
			kind: 'user',
			text: 'old words',
		});
		expect(cardsOf(state, STORE)).toMatchObject([{ status: 'delivered' }]);
	});
});

describe('a secret, on both sides', () => {
	const asked = (): State =>
		run([request('secret', 'STRIPE_KEY', { session: 'checkout api main' })], { start: sessions() })
			.state;

	it('asked → the card waits for the OK; the asked session has a secret run, not a card', () => {
		const state = asked();

		expect(cardsOf(state, STORE)[0]).toMatchObject({ status: 'waiting_ok', peerRef: CHECKOUT });
		expect(cardsOf(state, CHECKOUT)).toEqual([]);
		expect(state.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({
			kind: 'secret',
			text: 'STRIPE_KEY',
			status: 'waiting_ok',
		});
	});

	it('the developer says no → refused on both', () => {
		const state = run([{ type: 'answer_peer', askId: 'r1:ok', isApproved: false }], {
			start: asked(),
		}).state;

		expect(cardsOf(state, STORE)[0]).toMatchObject({ status: 'refused' });
		expect(state.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({ status: 'refused' });
	});

	it('allowed → copying on both, with no status words in the answer', () => {
		const state = run([{ type: 'answer_peer', askId: 'r1:ok', isApproved: true }], {
			start: asked(),
		}).state;

		expect(cardsOf(state, STORE)[0]).toMatchObject({ status: 'asking' });
		expect(cardsOf(state, STORE)[0]?.answer).toBeUndefined();
		expect(state.sessions[CHECKOUT]?.peerRuns[0]).toMatchObject({ status: 'asking' });
	});
});
