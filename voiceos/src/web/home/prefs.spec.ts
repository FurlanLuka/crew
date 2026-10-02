import { describe, expect, it } from 'bun:test';
import { shouldOpenVoice } from './prefs.js';

describe('shouldOpenVoice', () => {
	it.each([
		[true, true, false, true],
		// A first run: Home stays, and Home is the first run.
		[true, true, true, false],
		// crew's reads not back yet: nothing decided.
		[true, true, null, false],
		// The crew mark, a link to Home: always Home.
		[false, true, false, false],
		[true, false, false, false],
	])(
		'fresh %p, always %p, first run %p → %p',
		(isFreshHome, isAlwaysVoice, isFirstRun, expected) => {
			expect(shouldOpenVoice({ isFreshHome, isAlwaysVoice, isFirstRun })).toBe(expected);
		},
	);
});
