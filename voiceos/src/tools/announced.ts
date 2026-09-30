import { isSwitchOfferFresh, type State } from '../shared/protocol.js';
import { isHeldQuestion } from '../state/held-lines.js';
import { readLabel } from '../state/helpers.js';
import { type ToolResult, fail } from './results.js';
import { findSessionsNamedIn } from './session-naming.js';
import type { ToolContext } from './tools.js';

export const SWITCH_OFFERED_NOTE = 'switch offered';

// A question heard only as "<session> needs you" is not answered, and its session not opened, by
// words that do not name it: the developer is offered the switch instead.

interface NamedParams {
	state: State;
	ref: string;
	utterance: string | undefined;
}

export const isNamedIn = ({ state, ref, utterance }: NamedParams): boolean =>
	utterance !== undefined && findSessionsNamedIn(state, utterance).includes(ref);

// A yes to Voice OS's own "Switch to X?" opens X, whatever it holds.
export const isSwitchOfferedFor = (state: State, ref: string, now: number): boolean =>
	isSwitchOfferFresh(state.switchOffer, now) && state.switchOffer.ref === ref;

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

	// Voice OS asks it in code: a yes to it is a real offer the next turn can find.
	toolContext.dispatch({ type: 'offer_switch', ref });

	return {
		...fail(
			`Nothing was ${what}: ${ref}'s question was only announced and the developer has not heard it. Voice OS asked them "Switch to ${readLabel(state, ref)}?" itself: say nothing.`,
		),
		note: SWITCH_OFFERED_NOTE,
	};
};
