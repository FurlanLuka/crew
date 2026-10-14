import { describe, expect, it } from 'bun:test';
import { readMenuKey } from './box-menu-keys.js';

const press = (
	key: string,
	index: number,
	patch: { isShift?: boolean; isComposing?: boolean } = {},
) => readMenuKey({ key, isShift: false, isComposing: false, index, length: 3, ...patch });

describe('readMenuKey', () => {
	it('arrows move and wrap at both ends', () => {
		expect(press('ArrowDown', 0)).toEqual({ kind: 'move', index: 1 });
		expect(press('ArrowDown', 2)).toEqual({ kind: 'move', index: 0 });
		expect(press('ArrowUp', 0)).toEqual({ kind: 'move', index: 2 });
	});

	it('Esc closes; Tab and Enter pick', () => {
		expect(press('Escape', 1)).toEqual({ kind: 'close' });
		expect(press('Tab', 1)).toEqual({ kind: 'choose' });
		expect(press('Enter', 1)).toEqual({ kind: 'choose' });
	});

	it("Shift+Enter, an input method's Enter, other keys and an empty menu are the box's", () => {
		expect(press('Enter', 1, { isShift: true })).toBeNull();
		expect(press('Enter', 1, { isComposing: true })).toBeNull();
		expect(press('a', 1)).toBeNull();
		expect(
			readMenuKey({ key: 'Enter', isShift: false, isComposing: false, index: 0, length: 0 }),
		).toBeNull();
	});
});
