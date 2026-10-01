// "Voice OS, …" is said to Voice OS, not to the session on screen: those words reach that session
// only when the developer names it. Every path that sends to the screen's session asks this.
import type { State } from '../shared/protocol.js';
import { stripLeadingWakePhrase } from '../speech/wake.js';
import { isRefNamedIn } from './session-naming.js';
import type { ToolContext } from './tools.js';

export const isAddressedToVoiceOs = (utterance: string | undefined): boolean =>
	utterance !== undefined && stripLeadingWakePhrase(utterance) !== utterance;

interface IsSaidToVoiceOsParams {
	state: State;
	ref: string;
	toolContext: ToolContext;
}

export const isSaidToVoiceOs = ({ state, ref, toolContext }: IsSaidToVoiceOsParams): boolean => {
	const { utterance } = toolContext;

	return (
		isAddressedToVoiceOs(utterance) &&
		ref === toolContext.forwardTo &&
		!isRefNamedIn(state, ref, utterance ?? '')
	);
};

export const SAID_TO_VOICE_OS =
	'Not sent: the developer said "Voice OS, …", so these words are for you, not the session on screen. Act on them yourself (activate, deactivate, list_sessions, read_state…); words for that session go only if they named it.';
