import type { State } from './protocol.js';

// Voice off (nothing listens or speaks) or speech off (it listens, never speaks): either way no line
// is synthesized or played, it only shows on the page.
export const isSpeechSilenced = (state: State): boolean => state.voiceOff || state.speechOff;
