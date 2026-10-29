import { afterEach, describe, expect, it } from 'bun:test';
import type { ClientMessage } from '../shared/protocol.js';
import { clientLog, describeError, setClientLogSink } from './client-log.js';

afterEach(() => setClientLogSink(null));

describe('clientLog', () => {
	it('goes over the connection once it is there', () => {
		const sent: ClientMessage[] = [];
		setClientLogSink((message) => sent.push(message));

		clientLog('info', 'mic', 'press ignored', { reason: 'text only' });

		expect(sent).toEqual([
			{
				type: 'client_log',
				level: 'info',
				cat: 'mic',
				msg: 'press ignored',
				fields: { reason: 'text only' },
			},
		]);
	});

	it('is dropped with no connection, never thrown', () => {
		expect(() => clientLog('warn', 'mic', 'mic denied')).not.toThrow();
	});

	it('an error is its name and message, never a stack', () => {
		expect(describeError(new TypeError('nope'))).toEqual({ name: 'TypeError', message: 'nope' });
		expect(describeError('odd')).toEqual({ name: 'unknown', message: 'odd' });
	});
});
