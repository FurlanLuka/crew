import { describe, expect, it } from 'bun:test';
import { decideIsPhone, isPhonePath, readPlatform, shouldShowInstall } from './phone.js';

describe('decideIsPhone', () => {
	it.each([
		[{ pathname: '/phone/KEY', isMarked: false, width: 1440 }, true],
		[{ pathname: '/', isMarked: true, width: 1440 }, true],
		[{ pathname: '/voice', isMarked: false, width: 390 }, true],
		[{ pathname: '/voice', isMarked: false, width: 600 }, true],
		[{ pathname: '/voice', isMarked: false, width: 601 }, false],
	])('%j → %p', (signals, isPhone) => expect(decideIsPhone(signals)).toBe(isPhone));

	it('a phone link is /phone/<key>, nothing else', () => {
		expect(isPhonePath('/phone/abc')).toBe(true);
		expect(isPhonePath('/phones')).toBe(false);
	});
});

describe('shouldShowInstall', () => {
	it('only for a phone link in the browser, until waved away', () => {
		expect(shouldShowInstall({ isPhoneLink: true, isStandalone: false, isDismissed: false })).toBe(
			true,
		);
		expect(shouldShowInstall({ isPhoneLink: true, isStandalone: true, isDismissed: false })).toBe(
			false,
		);
		expect(shouldShowInstall({ isPhoneLink: true, isStandalone: false, isDismissed: true })).toBe(
			false,
		);
		expect(shouldShowInstall({ isPhoneLink: false, isStandalone: false, isDismissed: false })).toBe(
			false,
		);
	});
});

describe('readPlatform', () => {
	it.each([
		['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 0, 'ios'],
		['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5, 'ios'],
		['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0, 'other'],
		['Mozilla/5.0 (Linux; Android 15; Pixel 8)', 5, 'other'],
	])('%s (%d touch points) → %s', (ua, touch, platform) =>
		expect(readPlatform(ua, touch)).toBe(platform as 'ios' | 'other'),
	);
});
