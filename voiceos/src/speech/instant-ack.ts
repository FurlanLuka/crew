// "Mm-hm." a moment after the developer finished speaking, while the kernel still decides: the silence
// before a reply is what makes Voice OS feel slow. Responsive, not talkative: every doubt skips it.

// keepsTags: the line is voiced with its tags even though it is short: short lines lose their tags
// otherwise (isShortLine, state/held-lines.ts). A Soniox TTS → STT round trip kept every pool line's
// words whole after [warm] (12 of 12); [chuckles] put a laugh in front of most, so it is not used.
export interface InstantAckLine {
	text: string;
	keepsTags?: boolean;
}

// Neutral on purpose: nothing that promises an answer, so it fits a question and an instruction alike.
// Never the wake word or a stop word, which the open mic could hear back as the developer's.
export const INSTANT_ACK_POOL: readonly InstantAckLine[] = [
	{ text: '[warm] Mm-hm.', keepsTags: true },
	{ text: '[warm] Okay.', keepsTags: true },
	{ text: '[warm] Got it.', keepsTags: true },
	{ text: '[warm] One sec.', keepsTags: true },
	{ text: '[warm] Sure.', keepsTags: true },
	{ text: '[warm] On it.', keepsTags: true },
];

// A voice turn the router handed to the kernel: its words, and when the router took them.
export interface KernelTurnStart {
	text: string;
	startedAt: number;
}

// Called once the turn is over: an ack not yet said is not said.
export interface KernelTurnHandle {
	cancel: () => void;
}

// Counted from when the router took the words: Soniox's end-of-turn wait came before, so the developer
// hears about a second of silence in all.
export const INSTANT_ACK_DELAY_MS = 600;
// Quick back-and-forth: Voice OS just spoke, and another "Okay." would be filler on filler.
export const SPOKE_RECENTLY_MS = 6_000;
// The last lines used: neither is said next.
const HISTORY_KEPT = 2;

// Never one of the last two said; the pick among the rest is random so it does not sound scripted.
export const pickInstantAck = (
	history: readonly string[],
	random: () => number = Math.random,
): InstantAckLine => {
	const recent = history.slice(-HISTORY_KEPT);
	const fresh = INSTANT_ACK_POOL.filter((line) => !recent.includes(line.text));
	const pool = fresh.length > 0 ? fresh : INSTANT_ACK_POOL;

	return pool[Math.floor(random() * pool.length)] ?? (INSTANT_ACK_POOL[0] as InstantAckLine);
};

export const rememberInstantAck = (history: readonly string[], text: string): string[] =>
	[...history, text].slice(-HISTORY_KEPT);

export interface InstantAckMoment {
	isMuted: boolean;
	words: number;
	minWords: number;
	// Since Voice OS last finished a line; null when it has said nothing yet.
	msSinceSpoke: number | null;
	// A reply-rank line was queued since the turn began: a fast answer, or "Sent to X".
	hasReplySinceTurn: boolean;
	isPlayingOrQueued: boolean;
	isTalking: boolean;
}

export type InstantAckDecision = { kind: 'say' } | { kind: 'skip'; reason: string };

export const decideInstantAck = (moment: InstantAckMoment): InstantAckDecision => {
	if (moment.isMuted) {
		return { kind: 'skip', reason: 'muted' };
	}

	// Short words are a yes, a name, a fragment — or Voice OS's own echo: nothing to wait through.
	if (moment.words < moment.minWords) {
		return { kind: 'skip', reason: 'short' };
	}

	if (moment.isTalking) {
		return { kind: 'skip', reason: 'talking' };
	}

	if (moment.hasReplySinceTurn) {
		return { kind: 'skip', reason: 'answered' };
	}

	if (moment.isPlayingOrQueued) {
		return { kind: 'skip', reason: 'busy' };
	}

	if (moment.msSinceSpoke !== null && moment.msSinceSpoke < SPOKE_RECENTLY_MS) {
		return { kind: 'skip', reason: 'spoke recently' };
	}

	return { kind: 'say' };
};
