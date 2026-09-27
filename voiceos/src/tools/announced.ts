import { GRID, type State } from '../shared/protocol.js';
import { isHeldQuestion } from '../state/held-lines.js';
import { readLabel } from '../state/helpers.js';
import { type ToolResult, fail } from './results.js';
import { findSessionsNamedIn } from './session-naming.js';
import type { ToolContext } from './tools.js';

// A question heard only as "<session> needs you" is not answered, and its session not opened, by
// words that do not name it: the developer is offered the switch instead.

const SWITCH_OFFER_MS = 2 * 60_000;
const SWITCH_OFFER_PATTERN = /\bswitch\b/i;

interface NamedParams {
	state: State;
	ref: string;
	utterance: string | undefined;
}

export const isNamedIn = ({ state, ref, utterance }: NamedParams): boolean =>
	utterance !== undefined && findSessionsNamedIn(state, utterance).includes(ref);

interface HasOfferedSwitchParams {
	state: State;
	ref: string;
	screen: string | null | undefined;
	now: number;
}

export const hasOfferedSwitch = ({ state, ref, screen, now }: HasOfferedSwitchParams): boolean => {
	// Voice OS's own last reply on this screen offered it ("Switch to crew main?", "…switch to it?").
	const last = state.voiceLog[screen ?? GRID]?.at(-1);

	return (
		last !== undefined &&
		now - last.at <= SWITCH_OFFER_MS &&
		SWITCH_OFFER_PATTERN.test(last.reply) &&
		isNamedIn({ state, ref, utterance: last.reply })
	);
};

interface RefuseAnnouncedOnlyParams {
	state: State;
	ref: string;
	toolContext: ToolContext;
	what: 'answered' | 'sent' | 'switched';
}

export const refuseAnnouncedOnly = ({
	state,
	ref,
	toolContext,
	what,
}: RefuseAnnouncedOnlyParams): ToolResult | null => {
	if (
		!isHeldQuestion(state.sessions[ref]) ||
		toolContext.screen === ref ||
		isNamedIn({ state, ref, utterance: toolContext.utterance })
	) {
		return null;
	}

	return fail(
		`Nothing was ${what}: ${ref}'s question was only announced and the developer has not heard it. Ask them in a few words: "Switch to ${readLabel(state, ref)}?" — a yes to that switches.`,
	);
};
