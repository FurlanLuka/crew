// A switch right after a session's notification ("checkout is done: the retry backoff"): its held
// update plays there, unless it is old and the developer asked something — then the session answers
// fresh.
import { endsInQuestion } from '../shared/spoken.js';
import { isNamedIn } from './announced.js';
import { wasJustHeardAbout } from './asked-aloud.js';
import type { ToolContext } from './tools.js';
import type { State } from '../shared/protocol.js';

// "Tell me about that" plays what the session holds, unless it is older than this: then the
// question is sent and the session answers fresh.
export const HELD_FRESH_MS = 5 * 60_000;

interface NotificationParams {
	state: State;
	ref: string;
	toolContext: ToolContext;
}

export type NotificationReply = { kind: 'none' } | { kind: 'stale_held' };

export const decideNotificationReply = ({
	state,
	ref,
	toolContext,
}: NotificationParams): NotificationReply => {
	const isJustHeard = wasJustHeardAbout({
		spoken: state.spoken,
		ref,
		heardFrom: toolContext.heardFrom ?? toolContext.now(),
	});

	if (!isJustHeard || isNamedIn({ state, ref, utterance: toolContext.utterance })) {
		return { kind: 'none' };
	}

	const held = state.sessions[ref]?.heldLine;
	const isStale =
		held !== null && held !== undefined && toolContext.now() - held.at > HELD_FRESH_MS;

	return isStale && endsInQuestion(toolContext.utterance ?? '')
		? { kind: 'stale_held' }
		: { kind: 'none' };
};
