import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PendingAsk, Session, State } from '../../../shared/protocol.js';
import { createInitialState, createSession } from '../../../state/reducer.js';
import { PhoneHome } from './PhoneHome.js';

const session = (ref: string, patch: Partial<Session> = {}): Session => ({
	...createSession({ ref, label: ref, branch: 'b', cwd: '/w', dirs: [], isPinned: false }),
	status: 'idle',
	...patch,
});

const QUESTION: PendingAsk = {
	id: 'a1',
	ref: 'checkout-api/main',
	at: 1,
	kind: 'question',
	input: {},
	questions: [{ question: 'Merge it now?', multiSelect: false, options: [{ label: 'Yes' }] }],
};

const stateOf = (patch: Partial<State> = {}): State => {
	const sessions = [
		session('store-front/main'),
		session('checkout-api/main', { status: 'blocked' }),
		session('admin/main'),
	];

	return {
		...createInitialState(),
		sessions: Object.fromEntries(sessions.map((item) => [item.ref, item])),
		order: sessions.map((item) => item.ref),
		active: sessions.map((item) => item.ref),
		asks: [QUESTION],
		...patch,
	};
};

const render = (state: State) =>
	renderToStaticMarkup(<PhoneHome state={state} dispatch={() => undefined} />);

const rowOrder = (html: string) =>
	[...html.matchAll(/class="ph-row[^"]*" data-ref="([^"]+)"/g)].map((match) => match[1]);

describe('PhoneHome', () => {
	it('one row per session, the waiting one first with a badge, the rest with a chevron', () => {
		const html = render(stateOf());

		expect(rowOrder(html)).toEqual(['checkout-api/main', 'store-front/main', 'admin/main']);
		expect(html).toContain('class="ph-row waiting" data-ref="checkout-api/main"');
		expect(html).toContain('Asks: Merge it now?');
		expect(html.match(/ph-badge/g)).toHaveLength(1);
		expect(html.match(/ph-go/g)).toHaveLength(2);
		expect(html).toContain('3 sessions on 1 machine · 1 needs you');
	});

	it('no desktop rows and no blocks of latest work', () => {
		const html = render(
			stateOf({
				sessions: {
					...stateOf().sessions,
					'store-front/main': session('store-front/main', {
						stream: [
							{ id: 's1', at: 1, kind: 'text', text: 'A long paragraph of the latest work.' },
						],
					}),
				},
			}),
		);

		expect(html).not.toContain('vo-row');
		expect(html).not.toContain('A long paragraph of the latest work.');
	});

	it('groups first, in their colour, with their count; the rest after', () => {
		const html = render(
			stateOf({
				groups: [
					{ id: 'g1', name: 'Store', color: 'blue', refs: ['admin/main', 'store-front/main'] },
				],
				active: ['admin/main', 'store-front/main', 'checkout-api/main'],
			}),
		);

		expect(html).toContain('data-color="blue" aria-label="Store"');
		expect(html).toContain('<b>Store</b><span class="">2 sessions</span>');
		expect(html).toContain('<b>Not in a group</b>');
		expect(rowOrder(html)).toEqual(['admin/main', 'store-front/main', 'checkout-api/main']);
	});

	it('a session out of reach: a dimmed row that says so', () => {
		const html = render(stateOf({ active: ['store-front/main', 'vm1:gone/main'] }));

		expect(html).toContain('class="ph-row missing" data-ref="vm1:gone/main"');
		expect(html).toContain('Out of reach · starts when it&#x27;s back');
	});

	it('nothing active: the empty state', () =>
		expect(render(stateOf({ active: [] }))).toContain('Nothing active'));
});
