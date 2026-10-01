// Words right after a session's notification ("checkout is done: the retry backoff"): a reply to it
// switches there, unless the developer is mid-conversation with the screen; "For checkout?" when the
// words could be either.
import { createLogger } from '../log.js';
import { isMidExchangeWithScreen } from '../state/exchange.js';
import { isHeldQuestion } from '../state/held-lines.js';
import { endsInQuestion } from '../shared/spoken.js';
import { isNamedIn } from './announced.js';
import { wasJustHeardAbout } from './asked-aloud.js';
import { type ToolResult, checkRef, fail, succeed } from './results.js';
import type { ToolContext } from './tools.js';
import { isSwitchOfferFresh, type State } from '../shared/protocol.js';

const log = createLogger('tools');

// "Tell me about that" plays what the session holds, unless it is older than this: then the
// question is sent and the session answers fresh.
export const HELD_FRESH_MS = 5 * 60_000;

export const ASK_TARGET_NOTE = 'asked which session';

interface NotificationParams {
	state: State;
	ref: string;
	toolContext: ToolContext;
}

const wasJustHeard = ({ state, ref, toolContext }: NotificationParams): boolean =>
	wasJustHeardAbout({
		spoken: state.spoken,
		ref,
		heardFrom: toolContext.heardFrom ?? toolContext.now(),
	});

export type NotificationReply =
	| { kind: 'none' }
	| { kind: 'refuse'; why: string }
	| { kind: 'stale_held' };

export const decideNotificationReply = (params: NotificationParams): NotificationReply => {
	const { state, ref, toolContext } = params;

	if (!wasJustHeard(params) || isNamedIn({ state, ref, utterance: toolContext.utterance })) {
		return { kind: 'none' };
	}

	// Mid-conversation with the screen, a notification does not pull the developer away; a question or
	// plan they only heard the gist of does, when they reply to it: it is answered only once heard.
	if (isMidExchangeWithScreen(state, toolContext.now()) && !isHeldQuestion(state.sessions[ref])) {
		log.info('notification reply kept off screen', { ref });

		return {
			kind: 'refuse',
			why: `Not switched: the developer is mid-conversation with the session on screen. A reply to ${ref}'s notification goes to it without a switch: send_to ${ref} with their words.`,
		};
	}

	const held = state.sessions[ref]?.heldLine;
	const isStale =
		held !== null && held !== undefined && toolContext.now() - held.at > HELD_FRESH_MS;

	return isStale && endsInQuestion(toolContext.utterance ?? '')
		? { kind: 'stale_held' }
		: { kind: 'none' };
};

interface AskTargetParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
}

export const askTarget = ({ state, input, toolContext }: AskTargetParams): ToolResult => {
	const checked = checkRef(state, input.ref);

	if (!checked.ok) {
		return fail(checked.error);
	}

	const screen = toolContext.screen;

	// Words already sent this turn cannot also be held for the question.
	if ((toolContext.sentTo?.size ?? 0) > 0) {
		return fail('Not asked: the words were already sent this turn. Say nothing more.');
	}

	// "Switch to it?" is what was just asked about that session: these words answer it, not the update.
	if (
		isSwitchOfferFresh(state.switchOffer, toolContext.heardFrom ?? toolContext.now()) &&
		state.switchOffer.ref === checked.ref
	) {
		return fail(
			`Not asked: Voice OS just asked "Switch to ${checked.ref}?", and these words answer it (switch_offer under "Waiting on the developer"). A no changes nothing: say nothing.`,
		);
	}

	// Only right after that session's notification, and only on a session's screen: anywhere else it
	// would start asking about everything.
	if (
		!screen ||
		screen === checked.ref ||
		!wasJustHeard({ state, ref: checked.ref, toolContext })
	) {
		return fail(
			`Not asked: ${checked.ref} said nothing just before the developer spoke. Route the words as usual.`,
		);
	}

	toolContext.dispatch({
		type: 'ask_target',
		ref: checked.ref,
		screen,
		text: toolContext.utterance ?? '',
	});

	return {
		...succeed(`Voice OS asked "For ${checked.ref}?": say nothing.`),
		note: ASK_TARGET_NOTE,
	};
};
