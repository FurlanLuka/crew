// Files attached to a session, waiting for the next words that reach it: added when the server has
// stored them, taken by the developer's words where those enter delivery, given back when the words
// are cancelled or taken back, and dropped with the rest a session holds when it is deactivated.
// Pure: every tab replays the same inputs to the same chips.
import { MAX_ATTACHMENTS, type Attachment, type Input, type State } from '../shared/protocol.js';
import { withoutEffects } from './helpers.js';
import type { ReducerResult } from './reducer.js';

type AttachmentInput = Extract<Input, { type: 'attachment_added' | 'attachment_removed' }>;

export const isAttachmentInput = (input: Input): input is AttachmentInput =>
	input.type === 'attachment_added' || input.type === 'attachment_removed';

export const listWaiting = (state: State, ref: string): Attachment[] =>
	state.attachments[ref] ?? [];

const withWaiting = (state: State, ref: string, waiting: Attachment[]): State => {
	const { [ref]: _dropped, ...others } = state.attachments;

	return { ...state, attachments: waiting.length > 0 ? { ...others, [ref]: waiting } : others };
};

// Each file once, in the order attached, never past the cap.
const mergeAttachments = (first: Attachment[], second: Attachment[]): Attachment[] =>
	[...first, ...second]
		.filter(
			(attachment, index, all) => all.findIndex((other) => other.id === attachment.id) === index,
		)
		.slice(0, MAX_ATTACHMENTS);

export const joinAttachments = (
	first: Attachment[] | undefined,
	second: Attachment[] | undefined,
): Attachment[] | undefined => {
	const joined = mergeAttachments(first ?? [], second ?? []);

	return joined.length > 0 ? joined : undefined;
};

export const reduceAttachment = (state: State, input: AttachmentInput): ReducerResult => {
	if (!state.sessions[input.ref]) {
		return withoutEffects(state);
	}

	const waiting = listWaiting(state, input.ref);

	return withoutEffects(
		input.type === 'attachment_added'
			? withWaiting(state, input.ref, mergeAttachments(waiting, [input.attachment]))
			: withWaiting(
					state,
					input.ref,
					waiting.filter((attachment) => attachment.id !== input.id),
				),
	);
};

// What the developer's words to this session carry; the session's chips are cleared.
export const takeWaiting = (
	state: State,
	ref: string,
): { state: State; attachments: Attachment[] | undefined } => {
	const waiting = listWaiting(state, ref);

	return waiting.length > 0
		? { state: withWaiting(state, ref, []), attachments: waiting }
		: { state, attachments: undefined };
};

// Words that never went (cancelled, taken back): their files wait again, ahead of newer ones.
export const giveBack = (
	state: State,
	ref: string,
	attachments: Attachment[] | undefined,
): State =>
	attachments?.length && state.sessions[ref]
		? withWaiting(state, ref, mergeAttachments(attachments, listWaiting(state, ref)))
		: state;

export const dropWaiting = (state: State, ref: string): State =>
	state.attachments[ref] ? withWaiting(state, ref, []) : state;

// "Sent to checkout with 2 files."
export const describeCarried = (attachments: Attachment[] | undefined): string =>
	attachments?.length
		? ` with ${attachments.length === 1 ? 'a file' : `${attachments.length} files`}`
		: '';
