// iOS's audio session for the page (navigator.audioSession, Safari 17+). Left on "auto", Web Audio
// follows the ring/silent switch, and the session's category flips each time the mic opens, closes or
// changes mode — a flip interrupts the speech player's context mid-clip: the chime plays, the words
// don't. A phone is a voice app: one fixed category, heard with the switch on silent, like a call.
import { clientLog } from './client-log.js';

export type AudioSessionType = 'auto' | 'playback' | 'play-and-record';

interface AudioSessionLike {
	type: string;
}

export const chooseAudioSessionType = (isPhone: boolean): AudioSessionType =>
	isPhone ? 'play-and-record' : 'auto';

const readAudioSession = (): AudioSessionLike | null =>
	typeof navigator === 'undefined'
		? null
		: ((navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession ?? null);

// Idempotent: called on every gesture, it writes only when the type differs.
export const applyAudioSession = (
	isPhone: boolean,
	session: AudioSessionLike | null = readAudioSession(),
): void => {
	const type = chooseAudioSessionType(isPhone);

	if (!session || session.type === type) {
		return;
	}

	try {
		session.type = type;
		clientLog('info', 'speech', 'audio session set', { type });
	} catch (error) {
		clientLog('warn', 'speech', 'audio session refused', { type, error: String(error) });
	}
};
