// Words go to the session on screen, or to a session the developer named in them. Guessing that words
// were "really" for another session — an older line it said, its work mentioned in passing — sent
// replies to the wrong Claude: the name is checked in code, and whether the words speak to it, not
// only mention it, is asked of the judge.
import { createLogger } from '../log.js';
import { readSessionLabel } from '../shared/machines.js';
import { readMachine } from '../shared/machine-ref.js';
import type { State } from '../shared/protocol.js';
import { findMachineSaid } from './machines.js';
import { type ToolResult, fail, succeed } from './results.js';
import type { SentWords } from './send.js';
import { isRefNamedIn } from './session-naming.js';
import type { ToolContext } from './tools.js';

const log = createLogger('tools');

export const ASK_WHICH_NOTE = 'asked which session';

const toPlainWords = (text: string): string =>
	` ${text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()} `;

// "on vm1", "on my Mac", or a machine's name or id said beside the session ("vm1 checkout").
const readMachineSaid = (state: State, utterance: string): string | null => {
	const plain = toPlainWords(utterance);

	return (
		findMachineSaid(state, utterance) ??
		Object.values(state.machines).find((machine) =>
			[machine.id, machine.name].some((name) => plain.includes(toPlainWords(name))),
		)?.id ??
		null
	);
};

// Its name, its workspace or the developer's own name for it said — and, when a machine is said too,
// that machine is its. Two sessions sharing a workspace are both named by it: the judge and the kernel
// already chose one, and a name said is never the screen's.
const isNamed = (state: State, ref: string, utterance: string): boolean => {
	const machine = readMachineSaid(state, utterance);

	return isRefNamedIn(state, ref, utterance) && (machine === null || readMachine(ref) === machine);
};

interface GuardSendToParams {
	state: State;
	ref: string;
	words: SentWords;
	toolContext: ToolContext;
}

// null: send. 'screen': not named, so the words go to the session on screen (the caller forwards
// them; a kernel told to forward them talked instead). Otherwise "For X?" was asked, with the words
// held until the developer says which.
export const guardSendTo = async ({
	state,
	ref,
	words,
	toolContext,
}: GuardSendToParams): Promise<ToolResult | 'screen' | null> => {
	const screen = toolContext.forwardTo;
	const utterance = toolContext.utterance;

	// On Mission Control nothing is on screen to keep the words: the kernel asks which session itself.
	// The setup session has its own guard (isMisroutedToSetup): crew setup goes there from any screen.
	if (
		!screen ||
		!state.sessions[screen] ||
		ref === screen ||
		utterance === undefined ||
		state.sessions[ref]?.isPinned
	) {
		return null;
	}

	// A yes to "Want me to ask it?": the session was named when Voice OS offered.
	if (words.source === 'earlier' && words.text === toolContext.askedBack) {
		return null;
	}

	const label = readSessionLabel(state, ref);

	if (!isNamed(state, ref, utterance)) {
		// "I meant that for the other one": the screen already got those words; sending them there again
		// would only repeat them.
		if (words.source === 'earlier') {
			log.info('earlier words, no session named: asked which', { ref });

			return fail(
				'Not sent: the developer pointed earlier words at another session without naming it. Ask them in a few words to say which session; nothing was sent.',
			);
		}

		log.info('not named: words kept on the screen', { ref, screen });

		return 'screen';
	}

	// "I meant that for checkout", "send that to checkout too": earlier words pointed at a named session.
	if (words.source === 'earlier') {
		return null;
	}

	const spokenTo = await toolContext.judge({
		key: 'spoken_to',
		utterance,
		context: `The session: ${label}`,
	});

	if (spokenTo === 'yes') {
		return null;
	}

	log.info('named, not spoken to: asked which session', { ref, spokenTo });
	toolContext.dispatch({ type: 'ask_which', ref, screen, text: words.text });

	return {
		...succeed(
			`Voice OS asked "For ${label}?" and holds the words until they answer: say nothing.`,
		),
		note: ASK_WHICH_NOTE,
	};
};
