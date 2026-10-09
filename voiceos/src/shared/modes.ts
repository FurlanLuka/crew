// A session's permission mode as the page, the kernel and the reducer name it, and the Claude Code
// mode a worker runs for it.
import { SESSION_MODES, type SdkMode, type SessionMode } from './protocol.js';

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
