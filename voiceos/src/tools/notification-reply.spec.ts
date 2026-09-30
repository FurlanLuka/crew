import { englishJudge } from '../../test/support/english-judge.js';
import { describe, expect, it } from 'bun:test';
import type { Action, State } from '../shared/protocol.js';
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
