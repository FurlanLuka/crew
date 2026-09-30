import { cleanSessionLine, cleanSpokenText } from '../shared/spoken.js';
import type { HeldLine, Session, Stamped, State } from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { describeAskAloud } from './asks.js';
import { capWords, readLabel, updateSession, withoutEffects } from './helpers.js';
import { hasBackgroundWork } from './subagents.js';

// A session the developer isn't looking at does not speak its lines: they wait until the developer
// switches there. Only a short one (a one-sentence answer) is still said where they are, unless a
// report they were told about waits unheard: alone, it would be heard without it.
const SHORT_LINE_WORDS = 12;

export const isShortLine = (text: string): boolean =>
	cleanSpokenText(text).split(/\s+/).filter(Boolean).length <= SHORT_LINE_WORDS;

export const isOnScreen = (state: State, ref: string): boolean =>
	state.view.kind === 'session' && state.view.ref === ref;

// Looking at a different session, not Mission Control: a question from elsewhere waits there.
export const isOnAnotherSession = (state: State, ref: string): boolean =>
	state.view.kind === 'session' && state.view.ref !== ref;

export const isHeldQuestion = (session: Session | undefined): boolean =>
	session?.heldLine?.kind === 'ask' ||
	(session?.heldLine?.kind === 'line' && session.heldLine.isAsking);

export type AnnouncementKind = 'done' | 'needs';

export type TurnLineDecision =
	| { kind: 'say' }
	| { kind: 'hold'; announce: AnnouncementKind | null };

interface DecideTurnLineParams {
	isShown: boolean;
	isShort: boolean;
	// What the session holds was announced already ("is done", "needs you") and is not yet heard.
	isHeldAnnounced: boolean;
	hasBackgroundAgents: boolean;
	needsUser: boolean;
	// The developer looks at another session, not Mission Control.
	isOnAnotherSession: boolean;
}

export const decideTurnLine = ({
	isShown,
	isShort,
	isHeldAnnounced,
	hasBackgroundAgents,
	needsUser,
	isOnAnotherSession,
}: DecideTurnLineParams): TurnLineDecision => {
	// A question, however short, is not asked over another session: like its asks, it waits there.
	const isQuestionElsewhere = needsUser && isOnAnotherSession;

	if (isShown || (isShort && !isHeldAnnounced && !isQuestionElsewhere)) {
		return { kind: 'say' };
	}

	if (needsUser) {
		return { kind: 'hold', announce: 'needs' };
	}

	// "Done" is said once, and only when the work is: background sub-agents still work after the turn.
	return { kind: 'hold', announce: hasBackgroundAgents || isHeldAnnounced ? null : 'done' };
};

interface DescribeAnnouncementParams {
	label: string;
	kind: AnnouncementKind;
	about?: string | null;
}

export const describeAnnouncement = ({
	label,
	kind,
	about,
}: DescribeAnnouncementParams): string => {
	const topic = about?.trim().replace(/[.!?]+$/, '');
	const verb = kind === 'done' ? 'is done' : 'needs you';

	if (!topic) {
		return `${label} ${verb}.`;
	}

	// A capped topic ends on its ellipsis: the pause says it was cut, a full stop would not.
	return `${label} ${verb}: ${topic}${topic.endsWith('…') ? '' : '.'}`;
};

const DONE_ABOUT_WORDS = 8;
const MIN_REQUEST_WORDS = 3;

interface DescribeDoneAboutParams {
	topic: string | null;
	isTopicPinned: boolean;
	// What the turn was asked, in the developer's words.
	asked: string | null;
}

export const describeDoneAbout = ({
	topic,
	isTopicPinned,
	asked,
}: DescribeDoneAboutParams): string | null => {
	// "Done" with nothing tying it to the work sounds random. A pinned topic stays put however the
	// work moves on, so it never says what just finished; a reply like "no" says nothing either.
	if (topic && !isTopicPinned) {
		return topic;
	}

	const request = cleanSpokenText(asked ?? '');

	return request.split(/\s+/).filter(Boolean).length >= MIN_REQUEST_WORDS
		? capWords(request, DONE_ABOUT_WORDS).replace(/[.!?,;:]+(…?)$/, '$1')
		: null;
};

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const describeMissed = (missed: number): string => {
	if (missed <= 0) {
		return '';
	}

	const count = NUMBER_WORDS[missed] ?? String(missed);
	const capitalized = `${count.charAt(0).toUpperCase()}${count.slice(1)}`;

	return missed === 1
		? ' One earlier update is on the page.'
		: ` ${capitalized} earlier updates are on the page.`;
};

interface DescribeHeldLineParams {
	text: string;
	missed: number;
	isWorking: boolean;
}

export const describeHeldLine = ({ text, missed, isWorking }: DescribeHeldLineParams): string => {
	// Heard on arrival: a line from work still under way is not its result.
	const line = cleanSessionLine(text).replace(/[.!?]*$/, '');
	const ending = isWorking ? ' — still working.' : '.';

	return `${line}${ending}${describeMissed(missed)}`;
};

type HeldContent =
	| { kind: 'line'; text: string; isAsking: boolean }
	| { kind: 'ask'; askId: string };

interface HoldParams {
	state: State;
	ref: string;
	content: HeldContent;
	stamped: Pick<Stamped, 'id' | 'at'>;
	// Held as it is announced (an ask's "needs you").
	isAnnounced?: boolean;
}

export const holdLine = ({
	state,
	ref,
	content,
	stamped,
	isAnnounced = false,
}: HoldParams): State =>
	// The latest line replaces the one before; the page keeps them all.
	updateSession(state, ref, (session) => {
		const held = session.heldLine;

		// A short afterword ("covered in the answer above") never takes the place of a report the
		// developer was told about: replayed alone, it would say nothing. A question always does.
		if (
			held?.isAnnounced &&
			content.kind === 'line' &&
			!content.isAsking &&
			isShortLine(content.text)
		) {
			return { ...session, heldLine: { ...held, missed: held.missed + 1 } };
		}

		return {
			...session,
			heldLine: {
				id: stamped.id,
				at: stamped.at,
				missed: held ? held.missed + 1 : 0,
				isAnnounced: isAnnounced || held?.isAnnounced === true,
				...content,
			} as HeldLine,
		};
	});

export const clearHeldLine = (state: State, ref: string): State =>
	state.sessions[ref]?.heldLine
		? updateSession(state, ref, (session) => ({ ...session, heldLine: null }))
		: state;

export const clearHeldAsk = (state: State, askId: string): State => {
	const session = Object.values(state.sessions).find(
		(candidate) => candidate.heldLine?.kind === 'ask' && candidate.heldLine.askId === askId,
	);

	return session ? clearHeldLine(state, session.ref) : state;
};

const isWorkingStatus = (session: Session): boolean =>
	session.status === 'running' || session.status === 'blocked' || hasBackgroundWork(session);

export const replayHeldLine = (state: State, ref: string): ReducerResult => {
	// The developer switched to it: what it said meanwhile plays now, once, and counts as heard.
	const session = state.sessions[ref];
	const held = session?.heldLine;

	if (!session || !held) {
		return withoutEffects(state);
	}

	const cleared = clearHeldLine(state, ref);
	const ask =
		held.kind === 'ask' ? state.asks.find((pending) => pending.id === held.askId) : undefined;

	// A held ask answered or closed meanwhile has nothing left to say.
	if (held.kind === 'ask' && !ask) {
		return withoutEffects(cleared);
	}

	const text = ask
		? describeAskAloud(ask, readLabel(state, ref))
		: held.kind === 'line'
			? describeHeldLine({
					text: held.text,
					missed: held.missed,
					isWorking: isWorkingStatus(session),
				})
			: '';
	const effect: Effect = {
		type: 'speak',
		text,
		source: ask ? 'alert' : 'narrator',
		ref,
		priority: 'high',
		isOwed: true,
		// The answer to the developer's own switch: no chime before it.
		isReply: true,
		...(ask || (held.kind === 'line' && held.isAsking) ? { isAsking: true } : {}),
	};

	return { state: cleared, effects: [effect] };
};
