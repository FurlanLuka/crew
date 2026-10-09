// The box's context meter, as words: "42k / 200k", and how close Claude Code is to compacting.
import type { ContextUsage } from './protocol.js';

export type ContextLevel = 'ok' | 'high' | 'full';

// Shares of the point where Claude Code compacts on its own (else of the window): amber with room
// for a few long turns left, red when it compacts soon.
const HIGH_SHARE = 0.8;
const FULL_SHARE = 0.95;

export const formatTokens = (tokens: number): string => {
	if (tokens < 1000) {
		return String(Math.round(tokens));
	}

	// Compared once rounded: 999,600 is "1M", never "1000k".
	if (Math.round(tokens / 1000) < 1000) {
		return `${Math.round(tokens / 1000)}k`;
	}

	return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
};

export const describeContextLevel = ({ used, max, compactAt }: ContextUsage): ContextLevel => {
	const limit = compactAt ?? max;
	const share = limit > 0 ? used / limit : 0;

	return share >= FULL_SHARE ? 'full' : share >= HIGH_SHARE ? 'high' : 'ok';
};

export const formatContextUsage = ({ used, max }: ContextUsage): string =>
	`${formatTokens(used)} / ${formatTokens(max)}`;

export const describeContextTitle = ({ used, max, compactAt }: ContextUsage): string => {
	const percent = max > 0 ? Math.round((used / max) * 100) : 0;
	const compacts =
		compactAt === undefined
			? ''
			: `; Claude Code compacts on its own at ${formatTokens(compactAt)}`;

	return `Context: ${used.toLocaleString('en')} of ${max.toLocaleString('en')} tokens (${percent}%)${compacts}`;
};
