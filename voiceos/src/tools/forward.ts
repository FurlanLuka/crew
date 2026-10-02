// Words handed to a session as chosen (chooseWordsFor): the one way forward, send_to and the answer
// fallback send them and record the send, so none re-chooses words another already chose.
import { createLogger } from '../log.js';
import type { State } from '../shared/protocol.js';
import { isDeliverWish } from '../state/delivery.js';
import { isActive } from '../shared/active.js';
import { SAID_TO_VOICE_OS, isSaidToVoiceOs } from './said-to-voice-os.js';
import { refuseInactive } from './activate.js';
import { type ToolResult, fail } from './results.js';
import type { ToolName } from './definitions.js';
import { normalizeSaid } from '../state/helpers.js';
import { describeMisroutedAnswer, sendText, type SentWords } from './send.js';
import type { ToolContext } from './tools.js';

const log = createLogger('tools');

interface SendRecordedParams {
	state: State;
	ref: string;
	// The words chosen for this session (chooseWordsFor).
	words: SentWords;
	input: Record<string, unknown>;
	name: 'forward' | 'send_to';
	toolContext: ToolContext;
}

export const sendRecorded = async ({
	state,
	ref,
	words,
	input,
	name,
	toolContext,
}: SendRecordedParams): Promise<ToolResult> => {
	// "List the remotes and sessions, what's active?" listed, and was then sent whole as well: the same
	// words did two things. Sent whole after a Voice OS command, they go only when they also ask the
	// session for work ("restart the servers and have it check the logs").
	const tookWords = toolContext.doneInTurn?.find((done) =>
		TOOLS_THAT_TAKE_WORDS.includes(done as ToolName),
	);

	// A switch or go back that found more in the words already asked the judge: the rest is the
	// developer's for where they went, whatever the kernel copied.
	if (
		tookWords &&
		toolContext.movedTo !== ref &&
		toolContext.utterance !== undefined &&
		normalizeSaid(words.text) === normalizeSaid(toolContext.utterance) &&
		(await toolContext.judge({
			key: 'more_than_command',
			utterance: toolContext.utterance,
			context: `Voice OS already did: ${tookWords}`,
		})) !== 'yes'
	) {
		log.info('words a Voice OS command took: not sent too', { tool: tookWords });

		return fail(`not sent: ${tookWords} already did what these words asked; do nothing more`);
	}

	if (isSaidToVoiceOs({ state, ref, toolContext })) {
		log.info('said to Voice OS: not sent', { ref, name });

		return fail(SAID_TO_VOICE_OS);
	}

	// An inactive session gets nothing: "Activate it?" keeps the words for it.
	if (!isActive(state, ref)) {
		return refuseInactive({ ref, toolContext, words: words.text });
	}

	// These words finish the sentence the previous ones began: the session gets it whole, joined as
	// said, and the reducer replaces the first half with it.
	const previous = toolContext.recentUtterances?.at(-1)?.trim();
	const isContinuation =
		input.continues === true && Boolean(previous) && words.source !== 'earlier';
	const text = isContinuation ? `${previous} ${words.text}` : words.text;

	log.info('words chosen', { ref, source: words.source, continues: isContinuation });

	const result = await sendText({
		state,
		ref,
		text,
		kind: input.kind,
		...(isContinuation ? { continues: { rest: words.text } } : {}),
		toolContext,
		isAboutMyNotes: input.my_notes === true,
		isAboutLastAction: input.about_last_action === true,
		...(isDeliverWish(input.deliver) ? { deliver: input.deliver } : {}),
	});

	// The voice log records what the session got, not what the model wrote (often nothing).
	const { ref: _named, ...unaddressed } = input;
	const recorded = name === 'forward' ? { ...unaddressed, text } : { ...input, text };

	return { ...result, recordAs: { name, input: recorded } };
};

// Voice OS commands that answer or act on the words themselves: once one ran, the whole words are done.
// Not the lookups (read_state, read_notes, read_history): reading first and then sending is one request.
const TOOLS_THAT_TAKE_WORDS: ToolName[] = [
	'list_sessions',
	'switch_view',
	'go_back',
	'play_missed',
	'deactivate',
	'mute',
	'hands_free',
	'crew_dev',
	'rename_session',
	'rename_machine',
	'open_doc',
	'debug_note',
	'note',
];

interface ForwardChosenParams {
	words: SentWords;
	// question, instruction or redirect: how the session is told the words.
	kind: unknown;
	toolContext: ToolContext;
	// The rest of the call that carries them (continues, my_notes, deliver…), when there is one.
	input?: Record<string, unknown>;
}

// To the session on screen: the forward itself, and where send_to and the answer fallback send words
// that named no other session.
export const forwardChosen = async ({
	words,
	kind,
	toolContext,
	input = {},
}: ForwardChosenParams): Promise<ToolResult> => {
	const state = toolContext.getState();
	const target = toolContext.forwardTo;

	if (!target || !state.sessions[target]) {
		return fail('no session to forward to: use send_to with a ref');
	}

	const misroutedAnswer = await describeMisroutedAnswer({
		state,
		ref: target,
		text: words.text,
		judge: toolContext.judge,
	});

	if (misroutedAnswer) {
		return fail(misroutedAnswer);
	}

	return sendRecorded({
		state,
		ref: target,
		words,
		input: { ...input, ...(kind === undefined ? {} : { kind }) },
		name: 'forward',
		toolContext,
	});
};
