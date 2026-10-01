import { describe, expect, it } from 'bun:test';
import type { State } from './protocol.js';
import { createFixtureState } from '../../test/support/state.js';
import { isActive, listActiveInOrder, listActiveMissing, listActiveRefs } from './active.js';

const VM1_REFS = ['vm1:setup', 'vm1:store/main'];

// The fixture's refs plus vm1's, with only the given ones in the active set.
const withActive = (active: string[]): State => ({
	...createFixtureState({ machine: { id: 'vm1', name: 'Personal', refs: VM1_REFS } }),
	active,
});

describe('isActive', () => {
	it("this Mac's setup → always, though never in the set", () => {
		expect(isActive(withActive([]), 'setup')).toBe(true);
	});

	it("a remote's setup → only when it is in the set: it is a session like any other", () => {
		expect(isActive(withActive([]), 'vm1:setup')).toBe(false);
		expect(isActive(withActive(['vm1:setup']), 'vm1:setup')).toBe(true);
	});

	it('any other session → whether it is in the set', () => {
		const state = withActive(['store-front/main']);

		expect(isActive(state, 'store-front/main')).toBe(true);
		expect(isActive(state, 'store-front/wrk1')).toBe(false);
	});
});

describe('listActiveRefs', () => {
	it('setup first, then the set in its order; one crew does not have is left out', () => {
		const state = withActive(['vm1:store/main', 'gone/main', 'store-front/wrk1']);

		expect(listActiveRefs(state)).toEqual(['setup', 'vm1:store/main', 'store-front/wrk1']);
	});

	it('nothing active → setup alone', () => {
		expect(listActiveRefs(withActive([]))).toEqual(['setup']);
	});
});

describe('listActiveInOrder', () => {
	it("the page's order, setup included", () => {
		const state = withActive(['vm1:store/main', 'store-front/wrk1']);

		expect(listActiveInOrder(state)).toEqual(['setup', 'store-front/wrk1', 'vm1:store/main']);
	});
});

describe('listActiveMissing', () => {
	it('active refs crew does not have now → in the set order', () => {
		const state = withActive(['vm2:store/main', 'store-front/main', 'gone/main']);

		expect(listActiveMissing(state)).toEqual(['vm2:store/main', 'gone/main']);
	});
});
