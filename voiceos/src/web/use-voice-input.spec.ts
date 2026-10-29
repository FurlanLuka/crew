import { describe, expect, it } from 'bun:test';
import { readTalkRefusal } from './use-voice-input.js';

const pressable = {
	isPressed: false,
	isMain: true,
	isVoiceOff: false,
	isOnDiscord: false,
	mode: 'push',
} as const;

describe('readTalkRefusal', () => {
	it('a press on the main screen in push to talk or dictation opens the mic', () => {
		expect(readTalkRefusal(pressable)).toBeNull();
		expect(readTalkRefusal({ ...pressable, mode: 'dictation' })).toBeNull();
	});

	it.each([
		[{ isPressed: true }, 'already pressed'],
		[{ isMain: false }, 'another screen is the main one'],
		[{ isVoiceOff: true }, 'voice is off'],
		[{ isOnDiscord: true }, 'Discord has the mic'],
		[{ mode: 'text' as const }, 'text only'],
		[{ mode: 'hands-free' as const }, 'a listening mode streams already'],
		[{ mode: 'on-demand' as const }, 'a listening mode streams already'],
	])('%j → %s', (change, reason) =>
		expect(readTalkRefusal({ ...pressable, ...change })).toBe(reason),
	);
});
