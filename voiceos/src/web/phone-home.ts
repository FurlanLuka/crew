// A session as the phone's Home card says it: its dot, its name, the machine when it isn't this one,
// and one line of where it stands — never its latest work, which is what the session's own screen is
// for.
import { LOCAL_MACHINE, readMachine } from '../shared/machine-ref.js';
import { readMachineTitle, readSessionLabel } from '../shared/machines.js';
import type { PendingAsk, Session, State } from '../shared/protocol.js';
import { describeWork } from '../state/working.js';
import { describeSessionBadge } from './derive.js';

export interface PhoneCard {
	dot: string;
	title: string;
	// Only another machine's: This Mac goes without saying.
	machine?: string;
	line: string;
	isWaiting: boolean;
}

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

const describeStanding = (session: Session, dot: string, now: number): string => {
	if (session.status === 'stopped') {
		return session.error ? 'Crashed' : 'Idle';
	}

	switch (dot) {
		case 'idle':
			return 'Ready';
		case 'starting':
			return 'Starting';
		default: {
			const age = describeWork(session, now).for;

			return age ? `Working · ${age}` : 'Working';
		}
	}
};

export const describePhoneCard = (state: State, ref: string, now: number): PhoneCard | null => {
	const session = state.sessions[ref];

	if (!session) {
		return null;
	}

	const badge = describeSessionBadge(session, state.asks);
	const machine = readMachine(ref);

	return {
		dot: badge.dot,
		title: readSessionLabel(state, ref),
		...(machine !== LOCAL_MACHINE ? { machine: readMachineTitle(state, machine) } : {}),
		line: badge.isAlarm
			? describeWait(session, pickAsk(state.asks.filter((ask) => ask.ref === ref)))
			: describeStanding(session, badge.dot, now),
		isWaiting: badge.isAlarm,
	};
};
