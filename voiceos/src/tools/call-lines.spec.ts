import { describe, expect, it } from 'bun:test';
import { describeToolCall } from './call-lines.js';

describe('describeToolCall', () => {
	it('read_notes → remembered as "read_notes"', () =>
		expect(describeToolCall({ name: 'read_notes', input: { workspace: null }, ok: true })).toBe(
			'read_notes',
		));

	it('a call that only reads (read_state) → not remembered', () =>
		expect(describeToolCall({ name: 'read_state', input: {}, ok: true })).toBeNull());
});
