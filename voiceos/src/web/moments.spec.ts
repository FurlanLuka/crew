import { describe, expect, it } from 'bun:test';
import type { State } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { describeMoment, describeSessionState } from './moments.js';

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

describe('describeSessionState', () => {
	it('its own open ask comes first', () =>
		expect(
			describeSessionState(
				createState({
					asks: [{ id: 'a1', ref: 'store-front/main', at: 1, kind: 'plan', input: {}, plan: 'p' }],
				}),
				'store-front/main',
			).kind,
		).toBe('ask'));

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
});
