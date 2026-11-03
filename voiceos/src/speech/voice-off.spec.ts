import { describe, expect, it } from 'bun:test';
import { configureLog } from '../log.js';
import { Store } from '../state/store.js';
import { followSpeechOff, followVoiceOff } from './voice-off.js';

configureLog({ quiet: true });

const follow = (store: Store) => {
	const calls: string[] = [];
	followVoiceOff({ store, onOff: () => calls.push('off'), onOn: () => calls.push('on') });

	return calls;
};

describe('followVoiceOff', () => {
	it('off, the same again, then on → one call each way, after the change', async () => {
		const store = new Store();
		const calls = follow(store);

		store.dispatch({ type: 'set_voice_off', voiceOff: true });
		expect(calls).toEqual([]);
		await Promise.resolve();
		store.dispatch({ type: 'set_voice_off', voiceOff: true });
		store.dispatch({ type: 'set_voice_off', voiceOff: false });
		await Promise.resolve();

		expect(calls).toEqual(['off', 'on']);
	});

	it('voice already off when it starts (the saved setting) → let go of at once', () => {
		const store = new Store();
		store.dispatch({ type: 'set_voice_off', voiceOff: true });

		expect(follow(store)).toEqual(['off']);
	});
});

describe('followSpeechOff', () => {
	it('off, the same again, then on → one call, only for off, after the change', async () => {
		const store = new Store();
		const calls: string[] = [];
		followSpeechOff({ store, onOff: () => calls.push('off') });

		store.dispatch({ type: 'set_speech_off', speechOff: true });
		expect(calls).toEqual([]);
		await Promise.resolve();
		expect(calls).toEqual(['off']);

		store.dispatch({ type: 'set_speech_off', speechOff: true });
		store.dispatch({ type: 'set_speech_off', speechOff: false });
		await Promise.resolve();
		expect(calls).toEqual(['off']);
	});

	it('speech already off when it starts (the saved setting) → no call: nothing is playing yet', async () => {
		const store = new Store();
		store.dispatch({ type: 'set_speech_off', speechOff: true });
		const calls: string[] = [];
		followSpeechOff({ store, onOff: () => calls.push('off') });
		await Promise.resolve();

		expect(calls).toEqual([]);
	});
});
