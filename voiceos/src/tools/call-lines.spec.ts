import { describe, expect, it } from 'bun:test';
import { describeToolCall } from './call-lines.js';

describe('describeToolCall', () => {
	it('read_notes → remembered as "read_notes"', () =>
		expect(describeToolCall({ name: 'read_notes', input: { workspace: null }, ok: true })).toBe(
			'read_notes',
		));

	it('a call that only reads (read_state) → not remembered', () =>
		expect(describeToolCall({ name: 'read_state', input: {}, ok: true })).toBeNull());

	it('activate and deactivate → remembered with their session; list_sessions only reads', () => {
		expect(
			describeToolCall({ name: 'activate', input: { name: 'vm1:signals/wrk1' }, ok: true }),
		).toBe('activate vm1:signals/wrk1');
		expect(describeToolCall({ name: 'deactivate', input: { ref: 'crew/main' }, ok: true })).toBe(
			'deactivate crew/main',
		);
		expect(
			describeToolCall({ name: 'list_sessions', input: { machine: 'vm1' }, ok: true }),
		).toBeNull();
	});
});
