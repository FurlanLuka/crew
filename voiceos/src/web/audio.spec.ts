import { afterEach, describe, expect, it } from 'bun:test';
import { Mic } from './audio.js';
import { setClientLogSink } from './client-log.js';
import type { ClientMessage } from '../shared/protocol.js';

const calls: string[] = [];
const realNavigator = globalThis.navigator;
const realAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

class FakeAudioContext {
	state = 'suspended';
	sampleRate = 48_000;
	audioWorklet = { addModule: async () => undefined };

	constructor() {
		calls.push('AudioContext');
	}

	resume() {
		calls.push('resume');
		this.state = 'running';

		return Promise.resolve();
	}

	close() {
		return Promise.resolve();
	}
}

const stubBrowser = (getUserMedia: () => Promise<MediaStream>) => {
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: { mediaDevices: { getUserMedia } },
	});
	Object.assign(globalThis, { AudioContext: FakeAudioContext });
};

afterEach(() => {
	calls.length = 0;
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: realNavigator });
	Object.assign(globalThis, { AudioContext: realAudioContext });
	setClientLogSink(null);
});

describe('Mic.ensure', () => {
	it('asks for the mic and starts its audio in the caller’s own turn, before anything awaits (iOS)', () => {
		stubBrowser(() => {
			calls.push('getUserMedia');

			return new Promise<MediaStream>(() => undefined);
		});
		const mic = new Mic({ onAudio: () => undefined, onStop: () => undefined });

		void mic.ensure();

		// Synchronously, still inside the press: nothing has been awaited yet.
		expect(calls).toEqual(['getUserMedia', 'AudioContext', 'resume']);
	});

	it('logs the start and the refusal by name and message', async () => {
		const sent: ClientMessage[] = [];
		setClientLogSink((message) => sent.push(message));
		stubBrowser(() =>
			Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })),
		);
		const mic = new Mic({ onAudio: () => undefined, onStop: () => undefined });

		await expect(mic.ensure()).rejects.toThrow('Permission denied');
		expect(sent).toEqual([
			{
				type: 'client_log',
				level: 'info',
				cat: 'mic',
				msg: 'ensure start',
				fields: { mode: 'raw' },
			},
			{
				type: 'client_log',
				level: 'warn',
				cat: 'mic',
				msg: 'ensure failed',
				fields: { mode: 'raw', name: 'NotAllowedError', message: 'Permission denied' },
			},
		]);
	});

	it('a page without getUserMedia (not a secure origin) is refused, not thrown at', async () => {
		Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
		const mic = new Mic({ onAudio: () => undefined, onStop: () => undefined });

		await expect(mic.ensure()).rejects.toThrow('secure origin');
	});
});
