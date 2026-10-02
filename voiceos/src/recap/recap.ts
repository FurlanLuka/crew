// "Status update": a short spoken recap of what happened, written when the developer asks — over
// Discord, with no page open, the updates pile up and one recap beats hearing each. Pure: what goes
// in, the prompt, and the plain line said when no model is at hand.
import { listActiveInOrder } from '../shared/active.js';
import type { SessionStatus, State } from '../shared/protocol.js';
import { stripTags } from '../shared/spoken.js';
import type { HistoryEntry } from '../tools/tools.js';
import { describeAskForMeanwhile } from '../state/asks.js';
import { sayRef } from '../state/helpers.js';
import { formatAge } from '../state/working.js';

// A few sentences, fast: Haiku. Its latency is what the developer waits through.
export const RECAP_MODEL = 'claude-haiku-4-5';
// The turns read per session: older ones in the window add length, not news.
export const MAX_TURNS_PER_SESSION = 4;
const MAX_DID_CHARS = 300;

export interface RecapTurn {
	asked: string | null;
	did: string;
	// "12m": how long ago it ended.
	ago: string;
}

export interface RecapSession {
	ref: string;
	label: string;
	status: SessionStatus;
	// What it waits on the developer for, in a few words ("asks: push to main?").
	waits: string[];
	// What it said that the developer has not heard yet.
	unheard: string | null;
	// Newest first.
	turns: RecapTurn[];
}

export interface RecapInput {
	// "the last hour", "the last 30 minutes".
	window: string;
	// One session asked about, or every active one.
	isOneSession: boolean;
	sessions: RecapSession[];
}

export const describeWindow = (minutes: number): string => {
	if (minutes === 60) {
		return 'the last hour';
	}

	return minutes % 60 === 0 ? `the last ${minutes / 60} hours` : `the last ${minutes} minutes`;
};

const clip = (text: string, max: number): string =>
	text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

const readUnheard = (state: State, ref: string): string | null => {
	const held = state.sessions[ref]?.heldLine;

	if (held?.kind === 'line') {
		return stripTags(held.text);
	}

	const waiting = state.meanwhile.find((item) => item.ref === ref && item.askId === undefined);

	return waiting?.about ?? null;
};

interface GatherRecapParams {
	state: State;
	history: HistoryEntry[];
	// null: every active session.
	ref: string | null;
	minutes: number;
	now: number;
}

// The sessions a recap covers: the one named, or every active one.
export const listRecapRefs = (state: State, ref: string | null): string[] =>
	ref ? [ref] : listActiveInOrder(state);

// Sessions with nothing to say in the window are left out: a recap names what moved.
export const gatherRecap = ({
	state,
	history,
	ref,
	minutes,
	now,
}: GatherRecapParams): RecapInput => {
	const since = now - minutes * 60_000;
	const refs = listRecapRefs(state, ref);
	const sessions = refs.flatMap((sessionRef): RecapSession[] => {
		const session = state.sessions[sessionRef];

		if (!session) {
			return [];
		}

		const waits = state.asks
			.filter((ask) => ask.ref === sessionRef)
			.map((ask) => describeAskForMeanwhile(ask).phrase);
		const turns = history
			.filter((entry) => entry.ref === sessionRef && Date.parse(entry.ts) >= since)
			.slice(0, MAX_TURNS_PER_SESSION)
			.map((entry) => ({
				asked: entry.asked,
				did: clip(entry.did, MAX_DID_CHARS),
				ago: formatAge(now - Date.parse(entry.ts)),
			}));
		const unheard = readUnheard(state, sessionRef);
		const isWorking = session.status === 'running' || session.status === 'blocked';

		return ref || waits.length > 0 || turns.length > 0 || unheard || isWorking
			? [
					{
						ref: sessionRef,
						// The spoken form, as every other line names it: "checkout api, main".
						label: sayRef(state, sessionRef),
						status: session.status,
						waits,
						unheard,
						turns,
					},
				]
			: [];
	});

	return { window: describeWindow(minutes), isOneSession: ref !== null, sessions };
};

export const RECAP_SYSTEM = `You write the short status update Voice OS, a voice assistant for coding sessions, says aloud when the developer asks what has been happening. The developer is listening, often away from the screen, so it must sound like a person catching them up, not a report.

You get each session: its name, its status, what it waits on the developer for, what it said that they have not heard yet, and the turns it finished in the time asked about (what it was asked, what it did, how long ago).

Rules:
- First anything a session waits on the developer for, then what got done, then what is still running. Leave out sessions with nothing to say.
- Name each session the way it is given, word for word.
- Say only what is given: never invent results, numbers, file names or what comes next.
- Plain spoken sentences: no lists, no markdown, no file paths, no code, no quotes, no tags.
- At most 60 words; with one session, at most 40.
- Nothing happened in that time: say so in one short sentence.

Reply with the update alone.`;

const describeSession = (session: RecapSession): string =>
	[
		`session "${session.label}" (${session.status})`,
		...session.waits.map((wait) => `  waits on the developer: ${wait}`),
		...(session.unheard ? [`  said, not heard yet: ${session.unheard}`] : []),
		...session.turns.map(
			(turn) =>
				`  ${turn.ago} ago — asked: ${turn.asked ?? '(nothing recorded)'} — did: ${turn.did}`,
		),
	].join('\n');

export const buildRecapMessage = (input: RecapInput): string =>
	[
		`time asked about: ${input.window}`,
		input.isOneSession ? 'about one session' : 'about every active session',
		...(input.sessions.length > 0 ? input.sessions.map(describeSession) : ['(no sessions moved)']),
	].join('\n');

// Said when no worded recap is ready: what waits on the developer first, then each session's latest.
export const composeRecapFallback = (input: RecapInput): string => {
	const waits = input.sessions.flatMap((session) =>
		session.waits.map((wait) => `${session.label} ${wait.replace(/[.?!]+$/, '')}.`),
	);
	const latest = input.sessions.flatMap((session) => {
		const said = session.unheard ?? session.turns[0]?.did;

		return said ? [`${session.label}: ${clip(stripTags(said), 160).replace(/[.?!]*$/, '.')}`] : [];
	});
	const lines = [...waits, ...latest];

	return lines.length > 0 ? lines.join(' ') : `Nothing new in ${input.window}.`;
};
