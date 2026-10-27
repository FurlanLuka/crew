// A session as the phone's Home row says it: its initials and dot, its name, the machine when it
// isn't this one, how long it has been at it, and one line of where it stands — never its latest
// work, which is what the session's own screen is for.
import { LOCAL_MACHINE, readMachine } from '../shared/machine-ref.js';
import { readMachineTitle, readSessionLabel } from '../shared/machines.js';
import type { PendingAsk, Session, State } from '../shared/protocol.js';
import { describeWork } from '../state/working.js';
import { describeSessionBadge } from './derive.js';

export interface PhoneCard {
	dot: string;
	title: string;
	// The row's tile: "store-front/main" → "SM", "Build box" → "BB".
	initials: string;
	// Only another machine's: This Mac goes without saying.
	machine?: string;
	line: string;
	// How long it has worked or waited ("7m"); none while it is idle.
	age?: string;
	isWaiting: boolean;
}

const firstLetter = (text: string): string =>
	[...text.replace(/[^\p{L}\p{N}]/gu, '')][0]?.toUpperCase() ?? '';

// A worktree's project and worktree ("store-front/main" → "SM"), so two worktrees of one project
// differ; any other name, its first two words.
export const readInitials = (title: string): string => {
	const parts = title.includes('/')
		? [title.slice(0, title.indexOf('/')), title.slice(title.lastIndexOf('/') + 1)]
		: title.split(/\s+/).slice(0, 2);

	return parts.map(firstLetter).join('') || '·';
};

// What a waiting session waits on, in a few words.
const describeWait = (session: Session, ask: PendingAsk | undefined): string => {
	switch (ask?.kind) {
		case 'question':
			return `Asks: ${ask.questions[0]?.question ?? 'a question'}`;
		case 'permission':
			return `Permission: ${ask.summary}`;
		case 'plan':
			return 'A plan to approve';
		case undefined:
			return session.needsUser?.text || 'Waiting on you';
		default:
			return 'Waiting on you';
	}
};

// The badge's own priority: the line names what the dot shows.
const ASK_PRIORITY: PendingAsk['kind'][] = ['permission', 'question', 'plan'];

const pickAsk = (asks: PendingAsk[]): PendingAsk | undefined =>
	ASK_PRIORITY.map((kind) => asks.find((ask) => ask.kind === kind)).find(Boolean) ?? asks[0];

const describeStanding = (session: Session, dot: string): string => {
	if (session.status === 'stopped') {
		return session.error ? 'Crashed' : 'Idle';
	}

	switch (dot) {
		case 'idle':
			return 'Ready';
		case 'starting':
			return 'Starting';
		default:
			return 'Working';
	}
};

export const describePhoneCard = (state: State, ref: string, now: number): PhoneCard | null => {
	const session = state.sessions[ref];

	if (!session) {
		return null;
	}

	const badge = describeSessionBadge(session, state.asks);
	const machine = readMachine(ref);
	const title = readSessionLabel(state, ref);
	const work = describeWork(session, now);
	const age = badge.isAlarm ? (work.waitingFor ?? work.for) : work.for;

	return {
		dot: badge.dot,
		title,
		initials: readInitials(title),
		...(machine !== LOCAL_MACHINE ? { machine: readMachineTitle(state, machine) } : {}),
		line: badge.isAlarm
			? describeWait(session, pickAsk(state.asks.filter((ask) => ask.ref === ref)))
			: describeStanding(session, badge.dot),
		...(age ? { age } : {}),
		isWaiting: badge.isAlarm,
	};
};
