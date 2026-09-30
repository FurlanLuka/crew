import { GRID, type State, type VoiceEntry } from '../shared/protocol.js';

// Older than this, "this" in the developer's words is about the session's own work, not what Voice
// OS just did.
export const RECENT_ACTION_MS = 120_000;

// Word-bounded, so "edit" and "item" are not "it".
const BACK_REFERENCE_PATTERN = /\b(?:this|that|it|the last one|the note|what (?:you|i) just)\b/i;

export const hasBackReference = (utterance: string): boolean =>
	BACK_REFERENCE_PATTERN.test(utterance);

interface ReadRecentActionParams {
	ref: string;
	// The screen the words were said on: its voice log, and the grid's, is what the developer just saw.
	screen: string | null | undefined;
	now: number;
}

interface LoggedEntry {
	screen: string;
	entry: VoiceEntry;
}

const FAILED_SUFFIX = ' (failed)';

// Words quoted back into a prompt line: enough to recognise them, not a whole reply read again.
export const MAX_QUOTED_CHARS = 120;

export const clipQuoted = (text: string): string =>
	text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS)}…` : text;

const readWords = (did: string): string[] => did.split(' ');

const isSentTo = ({ screen, entry }: LoggedEntry, ref: string): boolean =>
	// A forward goes to the session of the screen it was said on; send_to names its ref.
	entry.did.some((did) => {
		const [name, target] = readWords(did);

		return (name === 'forward' && screen === ref) || (name === 'send_to' && target === ref);
	});

// Only actions that carried the developer's words somewhere, or put words in front of them: a view
// switch or a mute left nothing "this" could point at.
const summarizeAction = (did: string, { screen, entry }: LoggedEntry): string | undefined => {
	const [name, first, second] = readWords(did);

	switch (name) {
		case 'debug_note':
			return 'saved it as a debug note';
		case 'note':
			return 'saved it as a note';
		case 'forward':
			return screen === GRID ? undefined : `sent it to ${screen}`;
		case 'send_to':
			return `sent it to ${first}`;
		case 'queued_message':
			return first === 'now'
				? `sent the words queued for ${second} now`
				: `took back the words queued for ${second}`;
		case 'answer':
			return `answered ${second}'s question`;
		case 'allow_denied':
			return `allowed a blocked action for ${first}`;
		case 'read_notes':
			// "Do the second one" right after the notes were read: the session never heard them.
			return entry.reply
				? `read the developer's notes back: "${clipQuoted(entry.reply)}"`
				: undefined;
		default:
			return undefined;
	}
};

const summarizeEntry = (logged: LoggedEntry): string | undefined => {
	const actions = logged.entry.did
		.filter((did) => !did.endsWith(FAILED_SUFFIX))
		.map((did) => summarizeAction(did, logged))
		.filter((action) => action !== undefined);

	return actions.length ? actions.join(' and ') : undefined;
};

export const readRecentAction = (
	state: State,
	{ ref, screen, now }: ReadRecentActionParams,
): string | undefined => {
	// "Tell it to check this debug note" right after one was saved: the session never saw the note, so
	// the bare words point at nothing. What the developer just did with Voice OS goes along.
	const screens = [...new Set([screen ?? GRID, GRID])];
	const newest = screens
		.flatMap((key) => (state.voiceLog[key] ?? []).map((entry) => ({ screen: key, entry })))
		.filter(({ entry }) => !entry.isIgnored)
		.sort((left, right) => right.entry.at - left.entry.at)[0];

	if (
		!newest ||
		newest.entry.isFailed ||
		now - newest.entry.at > RECENT_ACTION_MS ||
		isSentTo(newest, ref)
	) {
		return undefined;
	}

	const summary = summarizeEntry(newest);

	return summary
		? `(Voice OS note — just before this, the developer told Voice OS: "${newest.entry.utterance}", and Voice OS ${summary}.)`
		: undefined;
};

interface DescribeRecentActionParams extends ReadRecentActionParams {
	utterance: string | undefined;
}

export const describeRecentAction = (
	state: State,
	{ utterance, ...params }: DescribeRecentActionParams,
): string | undefined =>
	utterance && hasBackReference(utterance) ? readRecentAction(state, params) : undefined;
