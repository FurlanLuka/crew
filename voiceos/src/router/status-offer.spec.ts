import { describe, expect, it } from 'bun:test';
import { createToolContext } from '../../test/support/tool-context.js';
import type { ToolCall } from '../tools/definitions.js';
import { readStatusOffer } from './status-offer.js';

const read = (ref: string | null): ToolCall => ({ name: 'read_state', input: { ref }, ok: true });
const onWrk1 = () =>
	createToolContext({ view: { kind: 'session', ref: 'store-front/wrk1' } }).tools.getState();

describe('readStatusOffer', () => {
	it('an answer read from another active session → offered there', () =>
		expect(
			readStatusOffer({
				state: onWrk1(),
				calls: [read('store-front/main')],
				reply: 'It runs the tests.',
			}),
		).toBe('store-front/main'));

	it('the session named as the kernel heard it (its name, "Checkout") → the ref it resolved to', () => {
		const state = createToolContext({
			view: { kind: 'session', ref: 'store-front/wrk1' },
			names: { 'checkout-api/main': 'Checkout' },
		}).tools.getState();

		expect(readStatusOffer({ state, calls: [read('Checkout')], reply: 'It is idle.' })).toBe(
			'checkout-api/main',
		);
	});

	it.each([
		['a read that failed', [{ ...read('store-front/main'), ok: false }], 'It runs the tests.'],
		['an answer that asks back', [read('store-front/main')], 'Which branch, main or release?'],
		['the session on screen', [read('store-front/wrk1')], 'It runs the tests.'],
		['every session at once', [read(null)], 'Both are idle.'],
		['two sessions', [read('store-front/main'), read('checkout-api/main')], 'Both are idle.'],
		['no answer said', [read('store-front/main')], ''],
		[
			'a read and then a send',
			[read('store-front/main'), { name: 'send_to', input: { ref: 'store-front/main' }, ok: true }],
			'Sent.',
		],
	])('%s → nothing offered', (_case, calls, reply) =>
		expect(readStatusOffer({ state: onWrk1(), calls, reply })).toBeNull(),
	);

	it('a session that is not active → nothing offered', () => {
		const state = createToolContext({
			view: { kind: 'session', ref: 'store-front/wrk1' },
			active: ['store-front/wrk1'],
		}).tools.getState();

		expect(
			readStatusOffer({ state, calls: [read('store-front/main')], reply: 'It is idle.' }),
		).toBeNull();
	});
});
