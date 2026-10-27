import { describe, expect, it } from 'bun:test';
import { PcmPlayer } from './use-speech-player.js';

describe('PcmPlayer muted', () => {
	it('plays nothing and reports nothing: the main screen plays it, and the server times the rest', () => {
		const player = new PcmPlayer();
		const done: string[] = [];
		player.setNotify((id) => done.push(id));
		player.setMuted(true);

		// No AudioContext is touched: Bun has none, so playing would throw here.
		expect(() => {
			player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false, hasChime: true });
			player.receive({ type: 'audio', id: 'a1', base64: '', isLast: true });
			player.playChime();
		}).not.toThrow();
		expect(done).toEqual([]);
	});
});
