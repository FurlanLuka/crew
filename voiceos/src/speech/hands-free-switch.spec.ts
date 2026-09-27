import { describe, expect, it } from 'bun:test';
import type { ServerMessage } from '../shared/protocol.js';
import { createHandsFreeSwitch } from './hands-free-switch.js';

const createSwitch = ({ isListening = false, isTabOpen = true } = {}) => {
	const sent: ServerMessage[] = [];
	const said: string[] = [];
	const unlistened: string[] = [];
	const switchFor = createHandsFreeSwitch({
		isListening: () => isListening,
		unlisten: (client) => unlistened.push(client),
		send: (_, message) => {
			sent.push(message);

			return isTabOpen;
		},
		say: (text) => said.push(text),
	});

	return { toggle: switchFor('tab1'), sent, said, unlistened };
};

describe('createHandsFreeSwitch', () => {
	it('off while listening → the tab is told, the server stops hearing it, and it is said', () => {
		const { toggle, sent, said, unlistened } = createSwitch({ isListening: true });

		expect(toggle(false)).toBe('changed');
		expect(sent).toEqual([{ type: 'listen_off', reason: 'turned off by voice' }]);
		expect(unlistened).toEqual(['tab1']);
		expect(said).toEqual(['Hands-free off.']);
	});

	it('on while not listening → the tab is told to start', () => {
		const { toggle, sent, said, unlistened } = createSwitch();

		expect(toggle(true)).toBe('changed');
		expect(sent).toEqual([{ type: 'listen_on' }]);
		expect(unlistened).toEqual([]);
		expect(said).toEqual(['Hands-free on.']);
	});

	it.each([
		[true, 'Hands-free is already on.'],
		[false, 'Hands-free is already off.'],
	])('already %p → said so, nothing sent', (isOn, line) => {
		const { toggle, sent, said } = createSwitch({ isListening: isOn });

		expect(toggle(isOn)).toBe('already');
		expect(sent).toEqual([]);
		expect(said).toEqual([line]);
	});

	it('the tab is gone → no_tab, nothing said, nothing unlistened', () => {
		const { toggle, said, unlistened } = createSwitch({ isListening: true, isTabOpen: false });

		expect(toggle(false)).toBe('no_tab');
		expect(said).toEqual([]);
		expect(unlistened).toEqual([]);
	});
});
