import { describe, expect, it } from 'bun:test';
import {
	applyListenCommand,
	createEchoGatedSend,
	isEchoGated,
	describeListening,
	isInputMode,
	listenStartMessage,
	readStoredListenMode,
} from './listen-mode.js';

const storageWith = (items: Record<string, string>) => ({
	getItem: (key: string) => items[key] ?? null,
});

describe('readStoredListenMode', () => {
	it.each([
		[{}, 'push'],
		[{ 'voiceos.listenMode': 'on-demand' }, 'on-demand'],
		[{ 'voiceos.listenMode': 'hands-free' }, 'hands-free'],
		[{ 'voiceos.listenMode': 'dictation' }, 'dictation'],
		[{ 'voiceos.listenMode': 'text' }, 'text'],
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
		expect(describeListening({ mode: 'dictation', isAwake: false })).toContain('to dictate');
		expect(describeListening({ mode: 'dictation', isAwake: false, isDictating: true })).toContain(
			'Send when you are done',
		);
	});
});

describe('text mode', () => {
	it('is an input mode', () => expect(isInputMode('text')).toBe(true));

	it('a listen_off from the server leaves it alone: it has no mic to hand back', () =>
		expect(applyListenCommand('text', 'push')).toBe('text'));

	it('a listen_on still switches it, as it does every other mode', () =>
		expect(applyListenCommand('text', 'hands-free')).toBe('hands-free'));

	it('every other mode follows the server', () => {
		expect(applyListenCommand('hands-free', 'push')).toBe('push');
		expect(applyListenCommand('dictation', 'push')).toBe('push');
		expect(applyListenCommand('push', 'on-demand')).toBe('on-demand');
	});

	it('the box only takes typing', () =>
		expect(describeListening({ mode: 'text', isAwake: false })).toBe('Type a message…'));
});

describe('isEchoGated', () => {
	it('a phone in an always-listening mode holds its mic while Voice OS speaks', () => {
		expect(isEchoGated({ isPhone: true, mode: 'hands-free', isSpeaking: true })).toBe(true);
		expect(isEchoGated({ isPhone: true, mode: 'on-demand', isSpeaking: true })).toBe(true);
	});

	it('and sends again once it is quiet', () =>
		expect(isEchoGated({ isPhone: true, mode: 'hands-free', isSpeaking: false })).toBe(false));

	it('push to talk, dictation and text never hold: a press stops the speech', () => {
		for (const mode of ['push', 'dictation', 'text'] as const) {
			expect(isEchoGated({ isPhone: true, mode, isSpeaking: true })).toBe(false);
		}
	});

	it('a desktop keeps talking over Voice OS to interrupt it', () =>
		expect(isEchoGated({ isPhone: false, mode: 'hands-free', isSpeaking: true })).toBe(false));
});

describe('createEchoGatedSend', () => {
	const chunk = new ArrayBuffer(4);

	it('a phone listening hands-free sends nothing while speech is audible, then sends again', () => {
		const sent: ArrayBuffer[] = [];
		let isSpeaking = true;
		const gated = createEchoGatedSend({
			isPhone: true,
			readMode: () => 'hands-free',
			isAudibleWithin: () => isSpeaking,
			send: (part) => sent.push(part),
		});

		gated(chunk);
		expect(sent).toHaveLength(0);
		isSpeaking = false;
		gated(chunk);
		expect(sent).toHaveLength(1);
	});

	it('asks for the echo tail, not just what plays', () => {
		const asked: number[] = [];
		createEchoGatedSend({
			isPhone: true,
			readMode: () => 'on-demand',
			isAudibleWithin: (ms) => {
				asked.push(ms);

				return false;
			},
			send: () => undefined,
		})(chunk);

		expect(asked).toEqual([400]);
	});
});
