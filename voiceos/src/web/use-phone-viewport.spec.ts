import { describe, expect, it } from 'bun:test';
import { isKeyboardUp } from './use-phone-viewport.js';

describe('isKeyboardUp', () => {
	it('a keyboard takes far more than a toolbar does', () => {
		expect(isKeyboardUp(400, 844)).toBe(true);
		expect(isKeyboardUp(780, 844)).toBe(false);
	});

	it('the line is four fifths of the page; the whole screen is never a keyboard', () => {
		expect(isKeyboardUp(675, 844)).toBe(true);
		expect(isKeyboardUp(676, 844)).toBe(false);
		expect(isKeyboardUp(844, 844)).toBe(false);
	});
});
