import { cleanSpokenText } from '../shared/spoken.js';
import type { HeldLine, Session, Stamped, State } from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { describeAskAloud } from './asks.js';
import { readLabel, updateSession, withoutEffects } from './helpers.js';

// A session the developer isn't looking at does not speak its lines: they wait until the developer
// switches there. Only a short one (a one-sentence answer) is still said where they are.
const SHORT_LINE_WORDS = 12;

export const isShortLine = (text: string): boolean =>
	cleanSpokenText(text).split(/\s+/).filter(Boolean).length <= SHORT_LINE_WORDS;

export const isOnScreen = (state: State, ref: string): boolean =>
	state.view.kind === 'session' && state.view.ref === ref;

export const isHeldQuestion = (session: Session | undefined): boolean =>
	session?.heldLine?.kind === 'ask' ||
	(session?.heldLine?.kind === 'line' && session.heldLine.isAsking);

export type AnnouncementKind = 'done' | 'needs';

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
	if (kind === 'done') {
		return `${label} is done.`;
	}

	const topic = about?.trim().replace(/[.!?]+$/, '');

	return topic ? `${label} needs you: ${topic}.` : `${label} needs you.`;
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
	const line = cleanSpokenText(text).replace(/[.!?]*$/, '');
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
}

export const holdLine = ({ state, ref, content, stamped }: HoldParams): State =>
	// The latest line replaces the one before; the page keeps them all.
	updateSession(state, ref, (session) => ({
		...session,
		heldLine: {
			id: stamped.id,
			at: stamped.at,
			missed: session.heldLine ? session.heldLine.missed + 1 : 0,
			...content,
		} as HeldLine,
	}));

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
	session.status === 'running' || session.status === 'blocked';

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
