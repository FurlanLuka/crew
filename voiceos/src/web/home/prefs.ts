// What this browser remembers about opening crew; storage can throw (private windows), so every read
// has a default and every write may quietly do nothing.
const ALWAYS_VOICE_KEY = 'crew.alwaysVoice';
const LAST_HALF_KEY = 'crew.lastHalf';

export type Half = 'voice' | 'setup';

const read = (key: string): string | null => {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
};

const write = (key: string, value: string): void => {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Not remembered: Home still works, it just asks again.
	}
};

export const readAlwaysVoice = (): boolean => read(ALWAYS_VOICE_KEY) === '1';

export const writeAlwaysVoice = (isOn: boolean): void => write(ALWAYS_VOICE_KEY, isOn ? '1' : '0');

export const readLastHalf = (): Half => (read(LAST_HALF_KEY) === 'setup' ? 'setup' : 'voice');

export const writeLastHalf = (half: Half): void => write(LAST_HALF_KEY, half);

export interface ShouldOpenVoiceParams {
	// A fresh load of / (not the crew mark, not a link to Home).
	isFreshHome: boolean;
	isAlwaysVoice: boolean;
	// null while crew's reads are on their way: nothing is decided yet.
	isFirstRun: boolean | null;
}

// "Always open Voice OS" applies to a fresh load of / only, and never on a first run: Voice OS is
// greyed there (no worktree yet), so Home stays, pointing at Set up.
export const shouldOpenVoice = ({
	isFreshHome,
	isAlwaysVoice,
	isFirstRun,
}: ShouldOpenVoiceParams): boolean => isFreshHome && isAlwaysVoice && isFirstRun === false;
