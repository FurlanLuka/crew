import { cleanSessionLine, cleanSpokenText, stripTags } from '../shared/spoken.js';
import type { HeldLine, Session, SpokenLine, Stamped, State } from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { describeAskAloud } from './asks.js';
import { capWords, readLabel, updateSession, withoutEffects } from './helpers.js';
import { readElsewhereMachine, readSessionLabel } from '../shared/machines.js';
import { hasBackgroundWork } from './subagents.js';

// A session the developer isn't looking at does not speak its lines: they wait until the developer
// switches there. Only a short one (a one-sentence answer) is still said where they are, unless a
// report they were told about waits unheard: alone, it would be heard without it.
const SHORT_LINE_WORDS = 12;

export const isShortLine = (text: string): boolean =>
	stripTags(cleanSpokenText(text)).split(/\s+/).filter(Boolean).length <= SHORT_LINE_WORDS;

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
	// The developer is talking with this session without switching to it: its answers are theirs.
	isSubject?: boolean;
}

export const decideTurnLine = ({
	isShown,
	isShort,
	isHeldAnnounced,
	hasBackgroundAgents,
	needsUser,
	isOnAnotherSession,
	isSubject = false,
}: DecideTurnLineParams): TurnLineDecision => {
	// A question, however short, is not asked over another session: like its asks, it waits there.
	const isQuestionElsewhere = needsUser && isOnAnotherSession;

	if (isShown || isSubject || (isShort && !isHeldAnnounced && !isQuestionElsewhere)) {
		return { kind: 'say' };
	}

	if (needsUser) {
		return { kind: 'hold', announce: 'needs' };
	}

	// "Done" is said once, and only when the work is: background sub-agents still work after the turn.
	return { kind: 'hold', announce: hasBackgroundAgents || isHeldAnnounced ? null : 'done' };
};

// A pinned session is one the developer chose to follow across machines: its announcements say so,
// and name its machine unless they are in it.
// label: what an unpinned session is announced as; callers name those with or without their machine.
export const readAnnouncedLabel = (state: State, ref: string, label: string): string => {
	if (!state.pinned.includes(ref)) {
		return label;
	}

	const machine = readElsewhereMachine(state, ref);

	return `Your pinned ${readSessionLabel(state, ref)}${machine ? ` on ${machine}` : ''}`;
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

	// A capped line ends on its ellipsis: the pause says it was cut, a full stop would not. A done
	// turn is announced with its own words, not as "done": its work may go on.
	const lead = kind === 'done' ? `${label}:` : `${label} ${verb}:`;

	return `${lead} ${topic}${topic.endsWith('…') ? '' : '.'}`;
};

const DONE_ABOUT_WORDS = 14;
const MIN_SAID_WORDS = 2;

// What a finished turn is announced with: the session's own last line, shortened. A summary of the
// session's long-running work goes stale ("finished the architecture docs" for a turn that
// ended "checking whether the eval runs finished"), and a turn ending is not the work finishing.
export const describeDoneAbout = (said: string | null): string | null => {
	const line = stripTags(cleanSpokenText(said ?? ''));

	return line.split(/\s+/).filter(Boolean).length >= MIN_SAID_WORDS
		? capWords(line, DONE_ABOUT_WORDS).replace(/[.!?,;:]+(…?)$/, '$1')
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

// Its news was heard to its end: a reply to it from another screen may now offer the switch, and the
// meanwhile line has nothing left to say about it.
const markNewsHeard = (state: State, ref: string, at: number): State =>
	state.sessions[ref]
		? updateSession(
				{ ...state, meanwhile: state.meanwhile.filter((item) => item.ref !== ref) },
				ref,
				(session) => ({ ...session, updateHeardAt: at }),
			)
		: state;

// Replied to, or opened: the news has been answered, and offers no switch again.
export const forgetHeardUpdate = (state: State, ref: string): State =>
	state.sessions[ref]?.updateHeardAt === undefined
		? state
		: updateSession(state, ref, ({ updateHeardAt: _heard, ...session }) => session);

// An ask the meanwhile line said in full is no longer only announced: a reply answers it. Only while
// it is still the ask the session holds; a newer one from it was not what the line said.
const hearToldAsks = (state: State, line: SpokenLine): State =>
	(line.toldAsks ?? []).reduce((next, { ref, askId }) => {
		const held = next.sessions[ref]?.heldLine;

		return held?.kind === 'ask' && held.askId === askId ? clearHeldLine(next, ref) : next;
	}, state);

// What finishing a line means beyond itself: an update heard, or a question heard (its window
// for a yes starts now, not when it was queued).

export const markHeard = (state: State, line: SpokenLine, at: number, isCut: boolean): State => {
	// An update talked over was not heard to its end; a question talked over is being answered.
	const refs = line.isUpdate && !isCut ? (line.refs ?? (line.ref ? [line.ref] : [])) : [];
	const updated = refs.reduce(
		(next, ref) => markNewsHeard(next, ref, at),
		hearToldAsks(state, line),
	);
	const offer = updated.switchOffer;
	const target = updated.targetAsk;

	return line.isAsking && line.ref
		? {
				...updated,
				...(offer && offer.ref === line.ref && offer.heardAt === undefined && line.at >= offer.at
					? { switchOffer: { ...offer, heardAt: at } }
					: {}),
				...(target &&
				target.ref === line.ref &&
				target.heardAt === undefined &&
				line.at >= target.at
					? { targetAsk: { ...target, heardAt: at } }
					: {}),
			}
		: updated;
};
