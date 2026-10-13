import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { State } from '../../shared/protocol.js';
import { createInitialState, createSession } from '../../state/reducer.js';
import { readTabMenu } from './TabMenu.js';
import { readShownItems, TopBar } from './TopBar.js';

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
		<TopBar
			state={state}
			dispatch={() => undefined}
			onHome={() => undefined}
			onNewSession={() => undefined}
		/>,
	);

const DISCORD = {
	isConnected: true,
	isHearing: true,
	isOwnerIn: true,
	channelName: 'Voice OS',
	mode: 'hands-free',
} as const;

describe('TopBar', () => {
	it('the crew mark, Home with its count, one tab per active session, then New; never an inactive one', () => {
		const html = render(
			withSessions(['store-front/main', 'checkout-api/main'], ['store-front/main']),
		);

		expect(html).toContain('crew <span>voice os</span>');
		expect(html).toContain('<b>Home</b><span class="vo-count">1</span>');
		expect(html).toContain('data-ref="store-front/main"');
		expect(html).not.toContain('data-ref="checkout-api/main"');
		expect(html).toMatch(/class="vo-new "[^>]*aria-haspopup="menu"[^>]*>.*New/);
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

	it('settings: the gear becomes a labelled tab, current; elsewhere a quiet icon', () => {
		const html = render({ ...withSessions([]), view: { kind: 'settings' } });

		expect(html).toMatch(
			/class="vo-tab vo-settings"[^>]*aria-label="Voice OS settings"[^>]*aria-current="true"/,
		);
		expect(html).toContain('<b>Settings</b>');
		expect(render(withSessions([]))).toMatch(/class="vo-gear"[^>]*aria-label="Voice OS settings"/);
	});

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

describe('moving a tab', () => {
	it('every session tab can be dragged and says its keys; Home cannot', () => {
		const html = render(withSessions(['store-front/main']));

		expect(html).toMatch(/data-ref="store-front\/main"[^>]*draggable="true"/);
		expect(html).toMatch(
			/data-ref="store-front\/main"[^>]*aria-keyshortcuts="Alt\+ArrowLeft Alt\+ArrowRight"/,
		);
		expect(html.split('draggable="true"').length - 1).toBe(1);
	});
});

describe('groups', () => {
	const refs = ['a/main', 'b/main', 'c/main', 'd/main'];
	const STORE = { id: 'g1', name: 'store', color: 'teal' as const, refs: ['b/main', 'c/main'] };
	const grouped = (patch: Partial<State> = {}): State => ({
		...withSessions(refs),
		groups: [STORE],
		...patch,
	});

	it('closed → one chip in its colour where its first member sits: dots, name, count; its tabs not drawn', () => {
		const html = render(grouped());

		expect(html).toMatch(/class="vo-tab vo-gchip [^"]*"[^>]*data-group="g1"[^>]*data-color="teal"/);
		expect(html).toContain('<b>store</b><span class="vo-count ">2</span>');
		expect(html).not.toContain('data-ref="b/main"');
		expect(html.indexOf('data-ref="a/main"')).toBeLessThan(html.indexOf('data-group="g1"'));
		expect(html.indexOf('data-group="g1"')).toBeLessThan(html.indexOf('data-ref="d/main"'));
	});

	it('a member needs the developer → the count is red; the session on screen in it → a stronger tint', () => {
		const html = render(
			grouped({
				asks: [{ id: 'q', ref: 'c/main', at: 1, kind: 'question', input: {}, questions: [] }],
				view: { kind: 'session', ref: 'b/main' },
			}),
		);

		expect(html).toContain('<span class="vo-count alarm">2</span>');
		expect(html).toMatch(/class="vo-tab vo-gchip holds /);
	});

	it('open → only its tabs, inside its box, with ‹; Home and New stay; nothing else', () => {
		const html = render(grouped({ openGroup: 'g1' }));

		expect(html).toMatch(/class="vo-gbox" data-group="g1" data-color="teal"/);
		expect(html).toContain('data-ref="b/main"');
		expect(html).toContain('data-ref="c/main"');
		expect(html).not.toContain('data-ref="a/main"');
		expect(html).not.toContain('data-ref="d/main"');
		expect(html).toContain('<b>Home</b>');
		expect(html).toMatch(/class="vo-new /);
		expect(html).toMatch(/class="vo-tab vo-fold "[^>]*aria-label="Close store"/);
	});

	it('open, and a hidden session needs the developer → a red dot on ‹', () => {
		const html = render(
			grouped({
				openGroup: 'g1',
				asks: [{ id: 'q', ref: 'd/main', at: 1, kind: 'question', input: {}, questions: [] }],
			}),
		);

		expect(html).toMatch(/class="vo-tab vo-fold alarm"[^>]*>‹<span class="dot blocked">/);
	});

	it('open, but a member away (drawn as a plain tab) → the whole bar, nothing open', () => {
		const away = { ...grouped({ openGroup: 'g1' }), active: [...refs, 'vm1:x/main'] };
		const lone = {
			...away,
			groups: [{ ...STORE, refs: ['b/main', 'vm1:x/main'] }],
		};

		expect(readShownItems(lone).open).toBeNull();
		expect(
			readShownItems(lone).items.map((item) =>
				item.kind === 'session' ? item.ref : item.group.id,
			),
		).toEqual(refs);
		expect(readTabMenu(lone, 'a/main').others).toEqual([]);
	});

	it("a tab's menu: its groups to join, loose tabs to start one with (never itself), whether it is in one", () => {
		const loose = readTabMenu(grouped(), 'a/main');

		expect(loose.group).toBeNull();
		expect(loose.others.map((group) => group.id)).toEqual(['g1']);
		expect(loose.partners).toEqual(['d/main']);

		const member = readTabMenu(grouped(), 'b/main');

		expect(member.group?.id).toBe('g1');
		expect(member.others).toEqual([]);
		expect(member.partners).toEqual(['a/main', 'd/main']);
	});
});
