import { describe, expect, it } from 'bun:test';
import { applyAudioSession, chooseAudioSessionType } from './audio-session.js';

describe('chooseAudioSessionType', () => {
	it('fixes a phone on play-and-record and leaves a desktop to the browser', () => {
		expect(chooseAudioSessionType(true)).toBe('play-and-record');
		expect(chooseAudioSessionType(false)).toBe('auto');
	});
});

describe('applyAudioSession', () => {
	it('sets the type on a phone', () => {
		const session = { type: 'auto' };
		applyAudioSession(true, session);

		expect(session.type).toBe('play-and-record');
	});

	it('does nothing without navigator.audioSession', () => {
		expect(() => applyAudioSession(true, null)).not.toThrow();
	});
});

describe('applyAudioSession writes only a change', () => {
	// Every write can flip the category, which cuts a clip mid-word.
	const counting = (type: string) => {
		let current = type;
		let writes = 0;

		return {
			get type() {
				return current;
			},
			set type(next: string) {
				writes++;
				current = next;
			},
			get writes() {
				return writes;
			},
		};
	};

	it('a phone already on play-and-record is left alone', () => {
		const session = counting('play-and-record');
		applyAudioSession(true, session);

		expect(session.writes).toBe(0);
	});

	it('a desktop on auto is left alone', () => {
		const session = counting('auto');
		applyAudioSession(false, session);

		expect(session.writes).toBe(0);
	});

	it('a refused write does not throw', () => {
		const session = {
			get type() {
				return 'auto';
			},
			set type(_next: string) {
				throw new Error('not allowed');
			},
		};

		expect(() => applyAudioSession(true, session)).not.toThrow();
		expect(session.type).toBe('auto');
	});
});
