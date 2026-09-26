import type { PendingAsk, Session, State } from '../shared/protocol.js';
import { describeWork } from '../state/working.js';

export interface Badge {
	dot: string;
	label: string;
	isAlarm: boolean;
}

export interface SessionCounts {
	total: number;
	running: number;
	waiting: number;
}

export interface OtherSessionRow {
	ref: string;
	label: string;
	isWaiting: boolean;
	text: string;
	age: string | null;
}

export const describeSessionBadge = (session: Session, asks: PendingAsk[]): Badge => {
	const sessionAsks = asks.filter((ask) => ask.ref === session.ref);

	if (sessionAsks.some((ask) => ask.kind === 'permission')) {
		return { dot: 'blocked', label: 'permission', isAlarm: true };
	}

	if (sessionAsks.some((ask) => ask.kind === 'question')) {
		return { dot: 'blocked', label: 'question', isAlarm: true };
	}

	if (sessionAsks.some((ask) => ask.kind === 'plan')) {
		return { dot: 'blocked', label: 'plan', isAlarm: true };
	}

	if (session.needsUser) {
		return { dot: 'needs', label: 'asked you', isAlarm: true };
	}

	if (session.isPinned && session.status !== 'running') {
		return { dot: 'setup', label: `setup · ${session.status}`, isAlarm: false };
	}

	switch (session.status) {
		case 'running':
			return { dot: 'running', label: 'running', isAlarm: false };
		case 'starting':
			return { dot: 'starting', label: 'starting', isAlarm: false };
		case 'idle':
			return { dot: 'idle', label: 'idle', isAlarm: false };
		case 'blocked':
			return { dot: 'blocked', label: 'waiting', isAlarm: true };
		default:
			return { dot: 'stopped', label: session.error ? 'crashed' : 'stopped', isAlarm: false };
	}
};

export const readLastLine = (session: Session): string => {
	if (session.draft.trim()) {
		return session.draft.trim();
	}

	for (let i = session.stream.length - 1; i >= 0; i--) {
		const item = session.stream[i];

		if (!item) {
			continue;
		}

		if (item.kind === 'text') {
			return item.text;
		}

		if (item.kind === 'tool') {
			return `${item.name}: ${item.summary}`;
		}

		if (item.kind === 'user') {
			return `you: ${item.text}`;
		}
	}

	return session.status === 'stopped'
		? `Not started. Open it and say something, or say “start ${session.label}”.`
		: '';
};

export const countSessions = (state: State): SessionCounts => {
	const sessions = Object.values(state.sessions);
	const waitingRefs = new Set([
		...state.asks.map((ask) => ask.ref),
		...sessions.filter((session) => session.needsUser).map((session) => session.ref),
	]);

	return {
		total: sessions.length,
		running: sessions.filter((session) => session.status === 'running').length,
		waiting: waitingRefs.size,
	};
};

export const classifyDiffLine = (line: string): 'add' | 'del' | 'h' | 'ctx' => {
	if (line.startsWith('@@')) {
		return 'h';
	}

	if (line.startsWith('+')) {
		return 'add';
	}

	if (line.startsWith('-')) {
		return 'del';
	}

	return 'ctx';
};

export const formatDidLine = (did: string): string => {
	const isFailed = did.endsWith(' (failed)');
	const line = isFailed ? did.slice(0, -' (failed)'.length) : did;
	const [name = '', ...rest] = line.split(' ');
	const tail = rest.join(' ');
	const readableByName: Record<string, string> = {
		forward: `forwarded ${tail}`,
		send_to: `sent to ${tail}`,
		switch_view: tail === 'mission control' ? 'went to Mission Control' : `opened ${tail}`,
		start_session: `started ${tail}`,
		stop_session: `ended ${tail}`,
		crew_dev: `dev servers: ${tail}`,
		answer: `answered ${tail}`,
		interrupt: `stopped ${tail}'s turn`,
		mute: 'went quiet',
		dev_offer: `${rest[0] === 'accepted' ? 'accepted' : 'declined'} the fix offer`,
		allow_denied: `allowed ${tail} once`,
		debug_note: `noted for debugging ${tail}`,
	};

	return `${readableByName[name] ?? line}${isFailed ? ' — failed' : ''}`;
};

const describeAsk = (ask: PendingAsk): string => {
	if (ask.kind === 'permission') {
		return `wants to ${ask.summary}`;
	}

	if (ask.kind === 'plan') {
		return 'has a plan to approve';
	}

	return ask.questions[0]?.question ?? 'has a question';
};

export const listOtherSessions = (
	state: State,
	screen: string | null,
	now: number,
): OtherSessionRow[] => {
	const rows: OtherSessionRow[] = [];

	for (const ref of state.order) {
		const session = state.sessions[ref];

		if (!session || ref === screen) {
			continue;
		}

		const ask = state.asks.find((pendingAsk) => pendingAsk.ref === ref);
		const work = describeWork(session, now);

		if (ask || session.needsUser) {
			const text = ask ? describeAsk(ask) : (session.needsUser?.text ?? '');
			rows.push({ ref, label: session.label, isWaiting: true, text, age: work.waitingFor });
		} else if (work.for) {
			rows.push({
				ref,
				label: session.label,
				isWaiting: false,
				text: work.requests.at(-1) ?? session.topic ?? session.status,
				age: work.for,
			});
		}
	}

	return [...rows.filter((row) => row.isWaiting), ...rows.filter((row) => !row.isWaiting)];
};
