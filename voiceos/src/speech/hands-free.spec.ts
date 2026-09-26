import { describe, expect, it } from 'bun:test';
import { computeReconnectDelay } from './hands-free.js';

describe('computeReconnectDelay', () => {
	it('backs off 0.5, 1, 2, 4 s, then gives up', () =>
		expect([0, 1, 2, 3, 4].map(computeReconnectDelay)).toEqual([500, 1000, 2000, 4000, null]));
});
