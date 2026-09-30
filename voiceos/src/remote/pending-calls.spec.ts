import { describe, expect, it } from 'bun:test';
import { PendingCalls } from './pending-calls.js';

const LONG_MS = 60_000;

const timeoutError = () => new Error('timed out');

describe('PendingCalls', () => {
	it('settled by id → each call gets its own answer; a second settle finds nothing', async () => {
		const calls = new PendingCalls<string>();
		const first = calls.open({ timeoutMs: LONG_MS, onTimeout: timeoutError });
		const second = calls.open({ timeoutMs: LONG_MS, onTimeout: timeoutError });

		expect(calls.settle(second.id, { ok: true, value: 'two' })).toBe(true);
		expect(calls.settle(first.id, { ok: false, error: new Error('refused') })).toBe(true);
		expect(calls.settle(first.id, { ok: true, value: 'late' })).toBe(false);

		expect(await second.promise).toBe('two');
		await expect(first.promise).rejects.toThrow('refused');
		expect(calls.size).toBe(0);
	});

	it('no answer in time → rejected with the timeout error; the late answer is dropped', async () => {
		const calls = new PendingCalls<string>();
		const call = calls.open({ timeoutMs: 5, onTimeout: timeoutError });

		await expect(call.promise).rejects.toThrow('timed out');
		expect(calls.settle(call.id, { ok: true, value: 'late' })).toBe(false);
	});

	it('the link goes → every call rejected at once', async () => {
		const calls = new PendingCalls<string>();
		const first = calls.open({ timeoutMs: LONG_MS, onTimeout: timeoutError });
		const second = calls.open({ timeoutMs: LONG_MS, onTimeout: timeoutError });

		calls.rejectAll(new Error('gone'));

		await expect(first.promise).rejects.toThrow('gone');
		await expect(second.promise).rejects.toThrow('gone');
		expect(calls.size).toBe(0);
	});
});
