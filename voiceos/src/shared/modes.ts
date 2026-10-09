// A session's permission mode as the page, the kernel and the reducer name it, and the Claude Code
// mode a worker runs for it.
import { isSetupRef } from './machine-ref.js';
import { SESSION_MODES, type SdkMode, type SessionMode, type State } from './protocol.js';

const SDK_MODES: Record<SessionMode, SdkMode> = {
	auto: 'auto',
	plan: 'plan',
	ask: 'default',
	skip: 'bypassPermissions',
};

export const MODE_LABELS: Record<SessionMode, string> = {
	auto: 'Auto',
	plan: 'Plan',
	ask: 'Ask',
	skip: 'Skip permissions',
};

export const toSdkMode = (mode: SessionMode): SdkMode => SDK_MODES[mode];

export const fromSdkMode = (mode: SdkMode): SessionMode =>
	SESSION_MODES.find((sessionMode) => SDK_MODES[sessionMode] === mode) ?? 'auto';

export const isSessionMode = (value: unknown): value is SessionMode =>
	SESSION_MODES.includes(value as SessionMode);

export const readMode = (state: State, ref: string): SessionMode =>
	state.modes[ref]?.mode ?? 'auto';

// The setup sessions are crew's own: they keep Auto, out of the chip's reach.
export const canChooseMode = (state: State, ref: string): boolean =>
	Boolean(state.sessions[ref]) && !isSetupRef(ref) && !state.sessions[ref]?.isPinned;

// What a mode is called aloud: "Plan mode.", "Skipping permissions."
export const describeModeAloud = (mode: SessionMode): string =>
	mode === 'skip' ? 'skipping permissions' : `in ${MODE_LABELS[mode]} mode`;
