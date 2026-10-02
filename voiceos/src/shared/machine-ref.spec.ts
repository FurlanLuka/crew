import { describe, expect, it } from 'bun:test';
import {
	isSetupRef,
	joinRef,
	machineOf,
	readMachine,
	refOn,
	splitRef,
	toLocalRef,
} from './machine-ref.js';

describe('splitRef', () => {
	it('a local ref → no machine, its workspace and worktree', () => {
		expect(splitRef('store-front/wrk1')).toEqual({
			machine: null,
			local: 'store-front/wrk1',
			workspace: 'store-front',
			worktree: 'wrk1',
		});
	});

	it('a remote ref → the machine, then the ref as that machine knows it', () => {
		expect(splitRef('vm1:store-front/wrk1')).toEqual({
			machine: 'vm1',
			local: 'store-front/wrk1',
			workspace: 'store-front',
			worktree: 'wrk1',
		});
	});

	it('a remote setup session → workspace setup, no worktree', () => {
		expect(splitRef('vm1:setup')).toEqual({
			machine: 'vm1',
			local: 'setup',
			workspace: 'setup',
			worktree: '',
		});
	});
});

describe('machineOf / toLocalRef', () => {
	it('a prefixed ask id → the machine, and the id the remote gave it', () => {
		expect(machineOf('vm1:ask-store-front/wrk1-3-99')).toBe('vm1');
		expect(toLocalRef('vm1:ask-store-front/wrk1-3-99')).toBe('ask-store-front/wrk1-3-99');
	});

	it('a local ask id → no machine', () => {
		expect(machineOf('ask-store-front/wrk1-3-99')).toBeNull();
	});
});

describe('refOn', () => {
	it.each([
		['local', 'store/main', 'store/main'],
		['local', 'setup', 'setup'],
		['vm1', 'store/main', 'vm1:store/main'],
		['vm1', 'setup', 'vm1:setup'],
	])('%s, %s → %s', (machine, local, ref) => {
		expect(refOn(machine, local)).toBe(ref);
	});
});

describe('joinRef', () => {
	it('no machine → the ref unchanged', () => {
		expect(joinRef(null, 'store/main')).toBe('store/main');
	});

	it('joined then split → the same parts', () => {
		expect(toLocalRef(joinRef('vm2', 'store/main'))).toBe('store/main');
		expect(machineOf(joinRef('vm2', 'store/main'))).toBe('vm2');
	});
});

describe('isSetupRef / readMachine', () => {
	it('setup on any machine is a setup session', () => {
		expect(isSetupRef('setup')).toBe(true);
		expect(isSetupRef('vm1:setup')).toBe(true);
		expect(isSetupRef('setup/main')).toBe(false);
	});

	it('readMachine → local for this Mac, the id otherwise', () => {
		expect(readMachine('store/main')).toBe('local');
		expect(readMachine('vm1:store/main')).toBe('vm1');
	});
});
