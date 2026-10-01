import { englishJudge } from '../../test/support/english-judge.js';
import { describe, expect, it } from 'bun:test';
import { SWITCH_OFFER_MS, type Action, type State } from '../shared/protocol.js';
import { createNullNotes } from '../../test/support/notes.js';
import { createFixtureState } from '../../test/support/state.js';
import { executeTool, type ToolContext } from './tools.js';
import { HELD_FRESH_MS } from './notification-reply.js';

const NOW = 10_000_000;
const NOTIFIER = 'checkout-api/main';
const SCREEN = 'store-front/main';

const createContext = (state: State, utterance: string) => {
	const actions: Action[] = [];
	const tools: ToolContext = {
		getState: () => state,
		dispatch: (action) => actions.push(action),
		readHistory: () => [],
		now: () => NOW,
		asks: state.asks,
		mute: () => undefined,
		saveDebugNote: () => undefined,
		judge: englishJudge,
		notes: createNullNotes(),
		setListenMode: () => 'changed' as const,
		openUrl: () => true,
		utterance,
		screen: SCREEN,
		forwardTo: SCREEN,
		heardFrom: NOW,
	};

	return { tools, actions };
};

const notified = (extra: Parameters<typeof createFixtureState>[0] = {}) =>
	createFixtureState(
		{
			view: SCREEN,
			heard: [
				{ text: 'checkout api, main is done: the retry backoff.', ref: NOTIFIER, secondsAgo: 6 },
			],
			update: { ref: NOTIFIER, text: 'Backoff now doubles, capped at thirty.' },
			...extra,
		},
		NOW,
	);

describe('replies to a notification', () => {
	it('mid-conversation with the screen → no switch: sent to the notifier instead', async () => {
		const state = notified({
			talkingWith: { ref: SCREEN, asked: 'x', answered: 'y', secondsAgo: 10 },
		});
		const { tools, actions } = createContext(state, 'What changed in the cap?');
		const result = await executeTool('switch_view', { ref: NOTIFIER }, tools);

		expect(result.ok).toBe(false);
		expect(String(result.content)).toContain(`send_to ${NOTIFIER}`);
		expect(actions).toEqual([]);
	});

	it('mid-conversation, a plan heard only as its gist → "switch to it" switches: it is answered only once heard', async () => {
		const state = notified({
			talkingWith: { ref: SCREEN, asked: 'x', answered: 'y', secondsAgo: 10 },
		});
		const session = state.sessions[NOTIFIER];

		if (session) {
			state.sessions[NOTIFIER] = {
				...session,
				status: 'blocked',
				heldLine: {
					id: 'h1',
					at: NOW - 6000,
					missed: 0,
					isAnnounced: true,
					kind: 'ask',
					askId: 'pl1',
				},
			};
		}

		state.asks = [
			{ id: 'pl1', ref: NOTIFIER, at: NOW - 6000, kind: 'plan', input: {}, plan: '# Retries' },
		];

		const { tools, actions } = createContext(state, 'Switch to it.');
		const result = await executeTool('switch_view', { ref: NOTIFIER }, tools);

		expect(result.ok).toBe(true);
		expect(actions).toEqual([{ type: 'switch_view', view: { kind: 'session', ref: NOTIFIER } }]);
	});

	it('a question after a held update older than five minutes → switched without replaying it', async () => {
		const state = notified();
		const session = state.sessions[NOTIFIER];

		if (session?.heldLine) {
			state.sessions[NOTIFIER] = {
				...session,
				heldLine: { ...session.heldLine, at: NOW - HELD_FRESH_MS - 1 },
			};
		}

		const { tools, actions } = createContext(state, 'What changed in the cap?');
		const result = await executeTool('switch_view', { ref: NOTIFIER }, tools);

		expect(actions).toEqual([
			{ type: 'switch_view', view: { kind: 'session', ref: NOTIFIER }, skipHeld: true },
		]);
		expect(String(result.content)).toContain('send_to it');
	});

	it('"For …?" only right after that session spoke; otherwise refused', async () => {
		const heard = createContext(notified(), 'review all of this');
		const quiet = createContext(createFixtureState({ view: SCREEN }, NOW), 'review all of this');

		const asked = await executeTool('ask_target', { ref: NOTIFIER }, heard.tools);
		const refused = await executeTool('ask_target', { ref: NOTIFIER }, quiet.tools);

		expect(asked).toMatchObject({ ok: true, note: 'asked which session' });
		expect(heard.actions).toEqual([
			{ type: 'ask_target', ref: NOTIFIER, screen: SCREEN, text: 'review all of this' },
		]);
		expect(refused.ok).toBe(false);
		expect(quiet.actions).toEqual([]);
	});

	it('"Switch to it?" just asked about that session → "For …?" refused: the words answer the offer', async () => {
		const state = {
			...notified(),
			switchOffer: { ref: NOTIFIER, at: NOW - 2_000, heardAt: NOW - 1_000 },
		};
		const heard = createContext(state, 'No.');
		const result = await executeTool('ask_target', { ref: NOTIFIER }, heard.tools);

		expect(result.ok).toBe(false);
		expect(heard.actions).toEqual([]);
	});

	it('"Switch to …?" about another session, or long since heard → "For …?" asked as usual', async () => {
		const offers = [
			{ ref: SCREEN, at: NOW - 2_000, heardAt: NOW - 1_000 },
			{ ref: NOTIFIER, at: NOW - SWITCH_OFFER_MS - 2_000, heardAt: NOW - SWITCH_OFFER_MS - 1 },
		];

		for (const switchOffer of offers) {
			const heard = createContext({ ...notified(), switchOffer }, 'review all of this');
			const result = await executeTool('ask_target', { ref: NOTIFIER }, heard.tools);

			expect(result).toMatchObject({ ok: true, note: 'asked which session' });
		}
	});

	it('the words already sent this turn → "For …?" refused: they cannot also be held', async () => {
		const heard = createContext(notified(), 'review all of this');
		const result = await executeTool(
			'ask_target',
			{ ref: NOTIFIER },
			{ ...heard.tools, sentTo: new Set([SCREEN]) },
		);

		expect(result.ok).toBe(false);
		expect(heard.actions).toEqual([]);
	});
});
