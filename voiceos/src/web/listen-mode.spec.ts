import { describe, expect, it } from 'bun:test';
import { describeListening, listenStartMessage, readStoredListenMode } from './listen-mode.js';

const storageWith = (items: Record<string, string>) => ({
	getItem: (key: string) => items[key] ?? null,
});

describe('readStoredListenMode', () => {
	it.each([
		[{}, 'push'],
		[{ 'voiceos.listenMode': 'on-demand' }, 'on-demand'],
		[{ 'voiceos.listenMode': 'hands-free' }, 'hands-free'],
		[{ 'voiceos.listenMode': 'nonsense' }, 'push'],
		// A tab from before the modes: its hands-free switch carries over.
		[{ 'voiceos.handsFree': '1' }, 'hands-free'],
		[{ 'voiceos.handsFree': '0' }, 'push'],
		// Chosen since: the new key wins over the old switch.
		[{ 'voiceos.listenMode': 'push', 'voiceos.handsFree': '1' }, 'push'],
	])('%p → %p', (items, mode) =>
		expect(readStoredListenMode(storageWith(items as Record<string, string>))).toBe(mode as never),
	);
});

describe('listenStartMessage', () => {
	it('names the mode, so the server knows whether to wait for "Voice OS"', () =>
		expect(listenStartMessage('on-demand', 48000)).toEqual({
			type: 'listen_start',
			sampleRate: 48000,
			mode: 'on-demand',
		}));
});

describe('describeListening', () => {
	it('says what to do in each mode, and whether on-demand is hearing you', () => {
		expect(describeListening({ mode: 'push', isAwake: false })).toBe(
			'Hold Space to talk, or type here…',
		);
		expect(describeListening({ mode: 'on-demand', isAwake: false })).toContain('Say “Voice OS”');
		expect(describeListening({ mode: 'on-demand', isAwake: true })).toContain('Listening to you');
		expect(describeListening({ mode: 'hands-free', isAwake: false })).toContain('just talk');
	});
});
