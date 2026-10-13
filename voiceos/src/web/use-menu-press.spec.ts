import { describe, expect, it } from 'bun:test';
import { fitSpot, readMenuSpot } from './use-menu-press.js';

describe('readMenuSpot', () => {
	it('a right-click → where it was', () =>
		expect(readMenuSpot({ x: 140, y: 22 }, { left: 100, bottom: 40 })).toEqual({ x: 140, y: 22 }));

	it('the Menu key or Shift+F10 (reported at 0,0) → under the element', () =>
		expect(readMenuSpot({ x: 0, y: 0 }, { left: 100, bottom: 40 })).toEqual({ x: 100, y: 40 }));
});

describe('fitSpot', () => {
	it('room to the right → where it was; near the right edge → moved left to fit; never off the left', () => {
		expect(fitSpot({ x: 100, y: 40 }, 260, 1280)).toEqual({ x: 100, y: 40 });
		expect(fitSpot({ x: 300, y: 40 }, 260, 390)).toEqual({ x: 122, y: 40 });
		expect(fitSpot({ x: 300, y: 40 }, 260, 200)).toEqual({ x: 8, y: 40 });
	});
});
