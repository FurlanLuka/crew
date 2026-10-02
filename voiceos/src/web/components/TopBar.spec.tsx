import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { State } from '../../shared/protocol.js';
import { createInitialState, createSession } from '../../state/reducer.js';
import { TopBar } from './TopBar.js';

const withSessions = (refs: string[], active: string[] = refs): State => ({
	...createInitialState(),
	sessions: Object.fromEntries(
		refs.map((ref) => [
			ref,
			createSession({
				ref,
				label: ref,
				branch: 'b',
				cwd: '/w',
				dirs: [],
				isPinned: ref === 'setup',
			}),
		]),
	),
	order: refs,
	active,
});

const render = (state: State): string =>
	renderToStaticMarkup(
		<TopBar state={state} dispatch={() => undefined} onHome={() => undefined} />,
	);

const DISCORD = {
	isConnected: true,
	isHearing: true,
	isOwnerIn: true,
	channelName: 'Voice OS',
	mode: 'hands-free',
} as const;

describe('TopBar', () => {
	it('the crew mark, Active, one tab per active session, then "+"; never an inactive one', () => {
		const html = render(
			withSessions(['store-front/main', 'checkout-api/main'], ['store-front/main']),
		);

		expect(html).toContain('crew <span>voice os</span>');
		expect(html).toContain('<b>Active</b>');
		expect(html).toContain('data-ref="store-front/main"');
		expect(html).not.toContain('data-ref="checkout-api/main"');
		expect(html).toContain('aria-label="Activate a worktree"');
	});

	it('the setup session never gets a tab: it lives in Set up', () =>
		expect(render(withSessions(['setup', 'store-front/main']))).not.toContain('data-ref="setup"'));

	it("another machine's session → its machine's name beside it", () => {
		const state: State = {
			...withSessions(['vm1:api/main']),
			machines: {
				vm1: {
					id: 'vm1',
					host: 'vm1',
					name: 'Build box',
					status: 'connected',
					detail: null,
					since: 1,
				},
			},
		};

		expect(render(state)).toContain('<small>Build box</small>');
	});

	it('the view on screen is the current tab', () => {
		const html = render({
			...withSessions(['store-front/main']),
			view: { kind: 'session', ref: 'store-front/main' },
		});

		expect(html).toMatch(
			/aria-current="true"[^>]*data-ref="store-front\/main"|data-ref="store-front\/main"[^>]*aria-current="true"/,
		);
	});

	it('settings: the gear is current', () =>
		expect(render({ ...withSessions([]), view: { kind: 'settings' } })).toMatch(
			/aria-label="Voice OS settings"[^>]*aria-current="true"/,
		));

	it('Claude usage on the right, this week then the 5-hour window', () =>
		expect(
			render({ ...withSessions([]), limits: { sevenDay: 34, fiveHour: 12, resetsAt: null } }),
		).toContain('34% · 12%'));

	it('the owner in the voice channel → "Voice via Discord" with its name', () =>
		expect(render({ ...withSessions([]), discord: DISCORD })).toContain(
			'Voice via Discord · Voice OS',
		));

	it('the bot connected, the owner elsewhere → no pill', () =>
		expect(
			render({ ...withSessions([]), discord: { ...DISCORD, isOwnerIn: false } }),
		).not.toContain('Voice via Discord'));

	it('in the channel but not hearing → the pill says so', () =>
		expect(render({ ...withSessions([]), discord: { ...DISCORD, isHearing: false } })).toContain(
			'Voice via Discord · Voice OS · not hearing',
		));
});
