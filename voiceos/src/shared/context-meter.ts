// The box's context meter, as words: "42k / 200k", and how close to full it is.
import type { ContextUsage } from './protocol.js';

export type ContextLevel = 'ok' | 'high' | 'full';

// Amber from here: room for a few long turns left.
const HIGH_SHARE = 0.7;
// Red from here: Claude Code compacts on its own soon.
const FULL_SHARE = 0.9;

export const formatTokens = (tokens: number): string => {
	if (tokens < 1000) {
		return String(Math.round(tokens));
	}

	if (tokens < 1_000_000) {
		return `${Math.round(tokens / 1000)}k`;
	}

	return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
};

export const describeContextLevel = ({ used, max }: ContextUsage): ContextLevel => {
	const share = max > 0 ? used / max : 0;

	return share >= FULL_SHARE ? 'full' : share >= HIGH_SHARE ? 'high' : 'ok';
};

export const formatContextUsage = ({ used, max }: ContextUsage): string =>
	`${formatTokens(used)} / ${formatTokens(max)}`;

export const describeContextTitle = ({ used, max }: ContextUsage): string =>
	`Context: ${used.toLocaleString('en')} of ${max.toLocaleString('en')} tokens (${
		max > 0 ? Math.round((used / max) * 100) : 0
	}%)`;
