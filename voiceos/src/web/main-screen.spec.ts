import { describe, expect, it } from 'bun:test';
import {
	markReloadByPage,
	readMainState,
	readTabId,
	rememberMain,
	renewTabId,
	shouldReclaim,
	wasTabRenewed,
	wasReloadedByPage,
} from './main-screen.js';

const memory = (items: Record<string, string> = {}) => ({
	items,
	getItem: (key: string) => items[key] ?? null,
	setItem: (key: string, value: string) => {
		items[key] = value;
	},
	removeItem: (key: string) => {
		delete items[key];
	},
});

const NONE = { tabId: null, device: '' };

describe('readTabId', () => {
	it('one id per tab: made once, read back on every load of that tab', () => {
		const tab = memory();
		const id = readTabId(tab);

		expect(id).not.toBe('');
		expect(readTabId(tab)).toBe(id);
		expect(readTabId(memory())).not.toBe(id);
	});

	it('without storage, still an id', () => expect(readTabId(null)).not.toBe(''));
});

describe('readMainState', () => {
	it('here, elsewhere, none, or not said yet — by tab, never by connection', () => {
		expect(readMainState(null, 't1')).toBe('unknown');
		expect(readMainState(NONE, 't1')).toBe('none');
		expect(readMainState({ tabId: 't1', device: 'iPhone' }, 't1')).toBe('here');
		expect(readMainState({ tabId: 't2', device: 'Mac · Chrome' }, 't1')).toBe('elsewhere');
	});
});

describe('the reclaim after a restart', () => {
	it('only the tab that held the main screen claims it back', () => {
		const held = memory();
		const aside = memory();

		expect(rememberMain({ tabId: 't1', device: 'iPhone' }, 't1', held)).toBe(true);
		expect(rememberMain({ tabId: 't1', device: 'iPhone' }, 't2', aside)).toBe(false);
		expect(shouldReclaim(NONE, rememberMain(NONE, 't1', held))).toBe(true);
		expect(shouldReclaim(NONE, rememberMain(NONE, 't2', aside))).toBe(false);
	});

	it('a tab that lost it to another forgets it held it', () => {
		const held = memory({ 'voiceos-was-main': '1' });

		expect(rememberMain({ tabId: 't2', device: 'iPhone' }, 't1', held)).toBe(false);
		expect(shouldReclaim(NONE, rememberMain(NONE, 't1', held))).toBe(false);
	});

	it('a main named again changes nothing to claim', () =>
		expect(shouldReclaim({ tabId: 't1', device: 'iPhone' }, true)).toBe(false));
});

describe('wasReloadedByPage', () => {
	it('true once after the page reloaded itself, then false', () => {
		const tab = memory();
		markReloadByPage(tab);

		expect(wasReloadedByPage(tab)).toBe(true);
		expect(wasReloadedByPage(tab)).toBe(false);
	});

	it('false without storage', () => expect(wasReloadedByPage(null)).toBe(false));
});

describe('renewTabId', () => {
	it('a duplicated tab gets its own id, kept for its next loads, and forgets the copied main', () => {
		const copied = readTabId(memory());
		const tab = memory({ 'voiceos-tab-id': copied, 'voiceos-was-main': '1' });
		const renewed = renewTabId(tab);

		expect(renewed).not.toBe(copied);
		expect(wasTabRenewed()).toBe(true);
		expect(readTabId(tab)).toBe(renewed);
		expect(rememberMain(NONE, renewed, tab)).toBe(false);
	});

	it('blocked storage still gives a new id for this load', () => {
		const blocked = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			},
			removeItem: () => {
				throw new Error('blocked');
			},
		};

		expect(renewTabId(blocked)).not.toBe('');
	});
});
