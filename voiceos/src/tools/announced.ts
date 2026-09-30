import { isSwitchOfferFresh, type State } from '../shared/protocol.js';
import { isHeldQuestion } from '../state/held-lines.js';
import { readLabel } from '../state/helpers.js';
import { type ToolResult, fail } from './results.js';
import { findSessionsNamedIn } from './session-naming.js';
import { isBareAnswer } from './send.js';
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

export const refuseAnnouncedOnly = async ({
	state,
	ref,
	toolContext,
	what,
}: RefuseAnnouncedOnlyParams): Promise<ToolResult | null> => {
	if (
		!isHeldQuestion(state.sessions[ref]) ||
		toolContext.screen === ref ||
		isNamedIn({ state, ref, utterance: toolContext.utterance })
	) {
		return null;
	}

	// When the words were said, not now: the kernel's own turn must not use up the developer's window.
	const saidAt = toolContext.heardFrom ?? toolContext.now();

	if (isSwitchOfferedFor(state, ref, saidAt)) {
		const said = toolContext.utterance ?? '';
		const isYes =
			(await isBareAnswer(toolContext.judge, said)) &&
			(await toolContext.judge({ key: 'approves', utterance: said })) === 'yes';

		// Their yes answered Voice OS's "Switch to X?": they go there and hear the question, then answer it.
		if (isYes) {
			toolContext.dispatch({ type: 'switch_view', view: { kind: 'session', ref }, announce: true });

			return {
				ok: true,
				content: `Switched to ${ref}: its question plays there now, and nothing was ${what}. Say nothing.`,
				note: SWITCH_OFFERED_NOTE,
			};
		}

		// Other words while that offer is open are not dropped in silence: they are told why.
		return fail(
			`Nothing was ${what}: ${ref}'s question was only announced, and Voice OS has just asked "Switch to ${readLabel(state, ref)}?". Tell them in a few words that its question comes first: a yes plays it.`,
		);
	}

	// Another switch is already offered: a second question would drop one of them unheard.
	if (isSwitchOfferFresh(state.switchOffer, saidAt)) {
		return fail(
			`Nothing was ${what}: ${ref}'s question was only announced, and Voice OS is waiting on its "Switch to ${readLabel(state, state.switchOffer.ref)}?". Tell them in a few words that ${readLabel(state, ref)} asked something, and that "switch to ${readLabel(state, ref)}" plays it.`,
		);
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
