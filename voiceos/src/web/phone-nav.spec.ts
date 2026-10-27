import { describe, expect, it } from 'bun:test';
import type { State, View } from '../shared/protocol.js';
import { createInitialState } from '../state/reducer.js';
import {
	decideSwipeEnd,
	decideSwipeStart,
	readBackView,
	readDepth,
	readTransition,
} from './phone-nav.js';

const HOME: View = { kind: 'active' };
const SESSION: View = { kind: 'session', ref: 'store-front/main', from: 'active' };
const OTHER: View = { kind: 'session', ref: 'admin/main', from: 'active' };
const MACHINE: View = { kind: 'activate', machine: 'vm1' };
const FROM_MACHINE: View = { kind: 'session', ref: 'vm1:store-api/main' };

const stateOn = (view: View): State => ({ ...createInitialState(), view });

describe('readDepth', () => {
	it('Home is the root; a session opened from a machine page sits under it', () => {
		expect(readDepth(HOME)).toBe(0);
		expect(readDepth(SESSION)).toBe(1);
		expect(readDepth({ kind: 'settings' })).toBe(1);
		expect(readDepth(MACHINE)).toBe(1);
		expect(readDepth(FROM_MACHINE)).toBe(2);
	});
});

describe('readTransition', () => {
	it('deeper pushes, up pops, sideways and the same screen do not slide', () => {
		expect(readTransition(HOME, SESSION)).toBe('push');
		expect(readTransition(SESSION, HOME)).toBe('pop');
		expect(readTransition(MACHINE, FROM_MACHINE)).toBe('push');
		expect(readTransition(SESSION, OTHER)).toBeNull();
		expect(readTransition(SESSION, { ...SESSION })).toBeNull();
	});
});

describe('readBackView', () => {
	it('a session goes back where it was opened from; Home has nowhere to go', () => {
		expect(readBackView(stateOn(SESSION))).toEqual(HOME);
		expect(readBackView(stateOn(FROM_MACHINE))).toEqual({ kind: 'activate', machine: 'vm1' });
		expect(readBackView(stateOn(HOME))).toBeNull();
	});
});

describe('decideSwipeStart', () => {
	it('waits for a few pixels, follows a rightward drag, leaves a scroll alone', () => {
		expect(decideSwipeStart({ dx: 3, dy: 2 })).toBe('wait');
		expect(decideSwipeStart({ dx: 30, dy: 5 })).toBe('track');
		expect(decideSwipeStart({ dx: 6, dy: 40 })).toBe('scroll');
		expect(decideSwipeStart({ dx: -20, dy: 0 })).toBe('scroll');
	});
});

describe('decideSwipeEnd', () => {
	it('past a third, or a flick, goes back; a short slow drag springs home', () => {
		expect(decideSwipeEnd({ dx: 140, velocity: 0.1, width: 390 })).toBe('back');
		expect(decideSwipeEnd({ dx: 60, velocity: 0.9, width: 390 })).toBe('back');
		expect(decideSwipeEnd({ dx: 60, velocity: 0.1, width: 390 })).toBe('cancel');
		expect(decideSwipeEnd({ dx: 10, velocity: 2, width: 390 })).toBe('cancel');
	});
});
