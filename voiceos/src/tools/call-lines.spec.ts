import { describe, expect, it } from 'bun:test';
import { describeToolCall, isReadOnlyOfScreen } from './call-lines.js';

describe('describeToolCall', () => {
	it('read_notes → remembered as "read_notes"', () =>
		expect(describeToolCall({ name: 'read_notes', input: { workspace: null }, ok: true })).toBe(
			'read_notes',
		));

	it('a call that only reads (read_state) → not remembered', () =>
		expect(describeToolCall({ name: 'read_state', input: {}, ok: true })).toBeNull());

	it('activate and deactivate → remembered with their session; list_sessions remembered too, so a question after it is never taken as an offer to pass words on', () => {
		expect(
			describeToolCall({ name: 'activate', input: { name: 'vm1:signals/wrk1' }, ok: true }),
		).toBe('activate vm1:signals/wrk1');
		expect(describeToolCall({ name: 'deactivate', input: { ref: 'crew/main' }, ok: true })).toBe(
			'deactivate crew/main',
		);
		expect(describeToolCall({ name: 'list_sessions', input: { machine: 'vm1' }, ok: true })).toBe(
			'list_sessions',
		);
	});
});

describe('isReadOnlyOfScreen', () => {
	const read = (ref: string | null, ok = true) => ({ name: 'read_state', input: { ref }, ok });

	it.each([
		['a read of the screen', [read('store-front/main')], 'store-front/main', true],
		[
			'two reads of the screen',
			[read('store-front/main'), read('store-front/main')],
			'store-front/main',
			true,
		],
		['a read of another session', [read('checkout-api/main')], 'store-front/main', false],
		['a read of every session', [read(null)], 'store-front/main', false],
		['a read that failed', [read('store-front/main', false)], 'store-front/main', false],
		[
			'a read beside another call',
			[read('store-front/main'), { name: 'list_sessions', input: {}, ok: true }],
			'store-front/main',
			false,
		],
		['no calls', [], 'store-front/main', false],
		['no session screen', [read('store-front/main')], null, false],
	] as const)('%s → %s', (_, calls, forwardTo, want) => {
		expect(isReadOnlyOfScreen([...calls], forwardTo)).toBe(want);
	});
});
