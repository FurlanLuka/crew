import { describe, expect, it } from 'bun:test';
import type { ListenMode, ServerMessage } from '../shared/protocol.js';
import { createListenSwitch } from './hands-free-switch.js';

const createSwitch = ({ mode = 'push' as ListenMode, isTabOpen = true } = {}) => {
	const sent: ServerMessage[] = [];
	const said: string[] = [];
	const unlistened: string[] = [];
	const switchFor = createListenSwitch({
		modeOf: () => mode,
		unlisten: (client) => unlistened.push(client),
		send: (_, message) => {
			sent.push(message);

			return isTabOpen;
		},
		say: (text) => said.push(text),
	});

	return { toggle: switchFor('tab1'), sent, said, unlistened };
};

describe('createListenSwitch', () => {
	it('to push to talk while listening → the tab is told, the server stops hearing it, and it is said', () => {
		const { toggle, sent, said, unlistened } = createSwitch({ mode: 'hands-free' });

		expect(toggle('push')).toBe('changed');
		expect(sent).toEqual([{ type: 'listen_off', reason: 'turned off by voice' }]);
		expect(unlistened).toEqual(['tab1']);
		expect(said).toEqual(['Push to talk.']);
	});

	it('to hands-free or on demand → the tab is told which', () => {
		const handsFree = createSwitch();
		const onDemand = createSwitch({ mode: 'hands-free' });

		expect(handsFree.toggle('hands-free')).toBe('changed');
		expect(handsFree.sent).toEqual([{ type: 'listen_on', mode: 'hands-free' }]);
		expect(handsFree.said).toEqual(['Hands-free.']);
		// From one listening mode to the other is a change, not "already".
		expect(onDemand.toggle('on-demand')).toBe('changed');
		expect(onDemand.sent).toEqual([{ type: 'listen_on', mode: 'on-demand' }]);
		expect(onDemand.unlistened).toEqual([]);
		// Its own name is never said: heard back, it would open a turn.
		expect(onDemand.said).toEqual(['On demand. Say my name first.']);
	});

	it.each([
		['push', 'Already push to talk.'],
		['hands-free', 'Already hands-free.'],
		['on-demand', 'Already on demand.'],
	] as [ListenMode, string][])('already %p → said so, nothing sent', (mode, line) => {
		const { toggle, sent, said } = createSwitch({ mode });

		expect(toggle(mode)).toBe('already');
		expect(sent).toEqual([]);
		expect(said).toEqual([line]);
	});

	it('the tab is gone → no_tab, nothing said, nothing unlistened', () => {
		const { toggle, said, unlistened } = createSwitch({ mode: 'hands-free', isTabOpen: false });

		expect(toggle('push')).toBe('no_tab');
		expect(said).toEqual([]);
		expect(unlistened).toEqual([]);
	});
});
