import type { Input, LastSpokenSend, Session, Stamped, State } from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { startAside } from './aside.js';
import { deliverSend, joinNotes, replaceRunning } from './delivery.js';
import { normalizeSaid, updateSession, withoutEffects } from './helpers.js';

type SendInput = Extract<Input, { type: 'send' }>;

// Soon enough after the first half that the developer is still finishing the same thought.
export const CONTINUATION_MS = 15_000;
const MIN_SHARE = 0.6;
const WITHDRAWN_KEPT = 20;
const SHORT_HALF_WORDS = 2;
const FILLER = new Set([
	'the',
	'a',
	'an',
	'and',
	'or',
	'to',
	'of',
	'in',
	'on',
	'for',
	'it',
	'is',
	'um',
	'uh',
	'like',
	'so',
	'can',
	'you',
	'could',
	'please',
]);

const toContentWords = (text: string): string[] =>
	normalizeSaid(text)
		.replace(/[^\p{L}\p{N}\s']/gu, ' ')
		.split(/\s+/)
		.filter((word) => word && !FILLER.has(word));

export const hasMostWords = (firstHalf: string, joined: string): boolean => {
	// The kernel rewrites what it sends: the first half is in the joined sentence when most of its
	// words are, not word for word. A one- or two-word half must be there whole.
	const words = toContentWords(firstHalf);
	const said = new Set(toContentWords(joined));

	if (words.length === 0) {
		return false;
	}

	const found = words.filter((word) => said.has(word)).length;

	return words.length <= SHORT_HALF_WORDS
		? found === words.length
		: found / words.length >= MIN_SHARE;
};

interface SpliceTailParams {
	// The message's text now; the developer's earlier words at its end; the whole sentence.
	carried: string;
	fragment: string;
	joined: string;
}

export const spliceTail = ({ carried, fragment, joined }: SpliceTailParams): string | null => {
	// A message can carry earlier words too (a merged follow-up): only the fragment at its end changes.
	if (normalizeSaid(carried) === normalizeSaid(fragment)) {
		return joined;
	}

	const tail = ` ${fragment.trim()}`;

	return carried.trimEnd().endsWith(tail)
		? `${carried.trimEnd().slice(0, -tail.length)} ${joined}`
		: null;
};

export type FirstHalf =
	| { kind: 'queued'; index: number }
	| { kind: 'running' }
	| { kind: 'aside'; itemId: string }
	| { kind: 'held'; askId: string };

interface LocateFirstHalfParams {
	state: State;
	ref: string;
	joined: string;
	at: number;
}

export const locateFirstHalf = ({
	state,
	ref,
	joined,
	at,
}: LocateFirstHalfParams): FirstHalf | null => {
	// Only the developer's last words, to this session, said moments ago, and really in the sentence.
	const last = state.lastSpokenSend;
	const session = state.sessions[ref];

	if (!last || !session || last.ref !== ref || at - last.at > CONTINUATION_MS) {
		return null;
	}

	if (!hasMostWords(last.text, joined)) {
		return null;
	}

	if (state.asks.some((ask) => ask.id === last.id && ask.kind === 'redirect')) {
		return { kind: 'held', askId: last.id };
	}

	const aside = session.stream.find((item) => item.id === last.id && item.kind === 'aside');

	if (aside?.kind === 'aside' && aside.status === 'asking') {
		return { kind: 'aside', itemId: last.id };
	}

	const index = session.queue.findIndex((message) => message.id === last.id);

	if (index !== -1) {
		return { kind: 'queued', index };
	}

	// A session blocked on an ask takes the words as its answer, as it always has.
	return session.status === 'running' && session.currentSendId === last.id
		? { kind: 'running' }
		: null;
};

const readRunningRequest = (session: Session): string => {
	const request = session.stream.findLast((item) => item.kind === 'user');

	return request?.kind === 'user' ? request.text : '';
};

const withNote = (note: string | undefined): { note?: string } => (note ? { note } : {});

const remember = (state: State, spoken: LastSpokenSend): State => ({
	...state,
	lastSpokenSend: spoken,
});

export const continueFirstHalf = (
	state: State,
	input: SendInput,
	stamped: Stamped,
): ReducerResult | null => {
	// null: the first half already ran its course (or cannot be found): only the new words go.
	const joined = input.text.trim();
	const { ref } = input;
	const firstHalf = locateFirstHalf({ state, ref, joined, at: stamped.at });
	const last = state.lastSpokenSend;
	const session = state.sessions[ref];

	if (!firstHalf || !last || !session) {
		return null;
	}

	if (normalizeSaid(joined) === normalizeSaid(last.text)) {
		return withoutEffects(state);
	}

	// The whole sentence may ask for what its first half did not ("…from my notes"): its note joins.
	const note = input.note?.trim() || undefined;

	switch (firstHalf.kind) {
		case 'held':
			return withoutEffects(
				remember(
					{
						...state,
						asks: state.asks.map((ask) =>
							ask.id === firstHalf.askId && ask.kind === 'redirect'
								? {
										...ask,
										text: spliceTail({ carried: ask.text, fragment: last.text, joined }) ?? joined,
										...withNote(joinNotes(ask.note, note)),
									}
								: ask,
						),
					},
					{ ref, id: last.id, text: joined, at: stamped.at },
				),
			);

		case 'queued': {
			const message = session.queue[firstHalf.index];
			const text = message
				? spliceTail({ carried: message.text, fragment: last.text, joined })
				: null;

			if (!message || text === null) {
				return null;
			}

			const edited = updateSession(state, ref, (current) => ({
				...current,
				queue: current.queue.map((queued, index) =>
					index === firstHalf.index
						? { ...queued, text, ...withNote(joinNotes(queued.note, note)) }
						: queued,
				),
			}));

			return withoutEffects(remember(edited, { ref, id: last.id, text: joined, at: stamped.at }));
		}

		case 'running': {
			const text =
				spliceTail({ carried: readRunningRequest(session), fragment: last.text, joined }) ?? joined;
			const replaced = replaceRunning({
				state,
				ref,
				text,
				note,
				stamped,
				isOwed: input.ack?.kind !== 'question',
			});

			// What the cut turn said since its first half was sent answers only that half.
			return {
				effects: [{ type: 'drop_speech', ref, before: stamped.at }, ...replaced.effects],
				state: remember(replaced.state, { ref, id: stamped.id, text: joined, at: stamped.at }),
			};
		}

		case 'aside': {
			// Withdrawn, never said: the whole question is asked aside instead, or at once if it is idle.
			const withdrawn = updateSession(state, ref, (current) => ({
				...current,
				stream: current.stream.map((item) =>
					item.id === firstHalf.itemId && item.kind === 'aside'
						? { ...item, status: 'withdrawn' as const }
						: item,
				),
				withdrawnAsides: [...current.withdrawnAsides, firstHalf.itemId].slice(-WITHDRAWN_KEPT),
			}));
			const asked =
				session.status === 'running' || session.status === 'blocked'
					? startAside({
							state: withdrawn,
							ref,
							question: joined,
							note,
							stamped,
						})
					: deliverSend({
							state: withdrawn,
							ref,
							text: joined,
							isSpoken: true,
							note,
							stamped,
							ack: input.ack,
						});

			return {
				...asked,
				state: remember(asked.state, { ref, id: stamped.id, text: joined, at: stamped.at }),
			};
		}
	}
};
