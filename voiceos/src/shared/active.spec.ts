import { describe, expect, it } from 'bun:test';
import type { State } from './protocol.js';
import { createFixtureState } from '../../test/support/state.js';
import {
	canRun,
	countMachineRefs,
	isActive,
	listActiveInOrder,
	listActiveMissing,
	listActiveRefs,
	listHeardAsks,
	listVoiceRefsOn,
} from './active.js';

const VM1_REFS = ['vm1:setup', 'vm1:store/main', 'vm1:chat/3fa9c1'];

// The fixture's refs plus vm1's, with only the given ones in the active set.
const withActive = (active: string[]): State => ({
	...createFixtureState({ machine: { id: 'vm1', name: 'Personal', refs: VM1_REFS } }),
	active,
});

describe('isActive / canRun', () => {
	// A setup session runs for Set up's chat but is never part of voice, even stored in the set.
	it.each([
		['setup', [], false, true],
		['setup', ['setup'], false, true],
		['vm1:setup', [], false, true],
		['vm1:setup', ['vm1:setup'], false, true],
		// The pre-setup name of this Mac's session is a worktree ref like any other now.
		['voiceos', [], false, false],
		['voiceos', ['voiceos'], true, true],
		['store-front/main', ['store-front/main'], true, true],
		['store-front/wrk1', ['store-front/main'], false, false],
		['vm1:store/main', ['vm1:store/main'], true, true],
		['vm1:store/main', [], false, false],
	])('%s with the set %j → active %p, runs %p', (ref, active, isRefActive, isRunnable) => {
		const state = withActive(active as string[]);

		expect(isActive(state, ref as string)).toBe(isRefActive as boolean);
		expect(canRun(state, ref as string)).toBe(isRunnable as boolean);
	});
});

describe('listActiveRefs', () => {
	it('the set in its order; one crew does not have, or a setup stored there, is left out', () => {
		const state = withActive(['vm1:store/main', 'gone/main', 'vm1:setup', 'store-front/wrk1']);

		expect(listActiveRefs(state)).toEqual(['vm1:store/main', 'store-front/wrk1']);
	});

	it('nothing active → nothing, though setup sessions run', () => {
		expect(listActiveRefs(withActive([]))).toEqual([]);
	});
});

describe('listVoiceRefsOn', () => {
	it('one machine → its worktrees in the page order, never its setup session', () => {
		const state = withActive([]);

		expect(listVoiceRefsOn(state, 'vm1')).toEqual(['vm1:store/main', 'vm1:chat/3fa9c1']);
		expect(listVoiceRefsOn(state, 'local')).not.toContain('setup');
		expect(listVoiceRefsOn(state, 'local').every((ref) => !ref.includes(':'))).toBe(true);
	});

	it('null → every machine, setup sessions left out', () => {
		const state = withActive([]);
		const refs = listVoiceRefsOn(state, null);

		expect(refs).toContain('vm1:store/main');
		expect(refs.filter((ref) => ref.endsWith('setup'))).toEqual([]);
		expect(refs).toEqual(state.order.filter((ref) => !ref.endsWith('setup')));
	});
});

describe('listActiveInOrder', () => {
	it("the page's order, setup never in it", () => {
		const state = withActive(['vm1:store/main', 'store-front/wrk1', 'setup']);

		expect(listActiveInOrder(state)).toEqual(['store-front/wrk1', 'vm1:store/main']);
	});
});

describe('listActiveMissing', () => {
	it('active refs crew does not have now → in the set order', () => {
		const state = withActive(['vm2:store/main', 'store-front/main', 'gone/main']);

		expect(listActiveMissing(state)).toEqual(['vm2:store/main', 'gone/main']);
	});
});

describe('listHeardAsks', () => {
	it("a setup session's asks are answered in Set up, never heard", () => {
		const ask = (ref: string) => ({ id: `ask-${ref}`, ref, kind: 'permission', at: 1 });
		const state = {
			...withActive(['store-front/main']),
			asks: [ask('setup'), ask('store-front/main'), ask('vm1:setup')],
		} as unknown as State;

		expect(listHeardAsks(state).map((heard) => heard.ref)).toEqual(['store-front/main']);
	});
});

describe('countMachineRefs', () => {
	it('a machine → its worktrees, how many are active, its plain sessions; never the setup session', () =>
		expect(countMachineRefs(withActive(['vm1:store/main', 'vm1:chat/3fa9c1']), 'vm1')).toEqual({
			worktrees: 1,
			active: 2,
			plain: 1,
		}));

	it('a machine with nothing → all zero', () =>
		expect(countMachineRefs(withActive([]), 'gpu')).toEqual({ worktrees: 0, active: 0, plain: 0 }));
});
