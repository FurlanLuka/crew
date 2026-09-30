import { readApprovalSummary } from '../shared/approval.js';
import { stripStreamingTag } from '../shared/spoken-tags.js';
import {
	isHeldAsk,
	type MachineStatus,
	type PendingAsk,
	type Session,
	type State,
} from '../shared/protocol.js';
import { listSessionDocs, type SessionDoc } from '../shared/session-docs.js';
import { hasBackgroundWork } from '../state/subagents.js';
import { describeWork } from '../state/working.js';
import { stripMarkdown } from './markdown.js';
import { readWorkspace } from '../shared/notes.js';
import { LOCAL_MACHINE, readMachine } from '../shared/machine-ref.js';
import {
	listMachineRefs,
	listWaitingRefs,
	readMachineName,
	readMachineTitle,
} from '../shared/machines.js';

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

	if (sessionAsks.some(isHeldAsk)) {
		return { dot: 'needs', label: 'confirm', isAlarm: true };
	}

	if (session.needsUser) {
		return { dot: 'needs', label: 'asked you', isAlarm: true };
	}

	if (session.compactingSince !== null) {
		return { dot: 'running', label: 'compacting', isAlarm: false };
	}

	// Its turn ended but its background sub-agents still work: not idle yet.
	if (session.status === 'idle' && hasBackgroundWork(session)) {
		return { dot: 'running', label: 'sub-agents', isAlarm: false };
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
	const draft = stripStreamingTag(session.draft);

	if (draft) {
		return stripMarkdown(draft);
	}

	for (let i = session.stream.length - 1; i >= 0; i--) {
		const item = session.stream[i];

		if (!item) {
			continue;
		}

		if (item.kind === 'text') {
			return stripMarkdown(item.text);
		}

		if (item.kind === 'tool') {
			return `${item.name}: ${item.summary}`;
		}

		if (item.kind === 'user') {
			return item.isApproval
				? `allowed once: ${readApprovalSummary(item.text)}`
				: `you: ${item.text}`;
		}
	}

	return session.status === 'stopped'
		? `Not started. Open it and say something, or say “start ${session.label}”.`
		: '';
};

// machine: one machine's (LOCAL_MACHINE for this Mac); absent for every machine.
export const countSessions = (state: State, machine?: string): SessionCounts => {
	const refs =
		machine === undefined ? Object.keys(state.sessions) : listMachineRefs(state, machine);

	return {
		total: refs.length,
		running: refs.filter((ref) => state.sessions[ref]?.status === 'running').length,
		waiting: listWaitingRefs(state, machine).length,
	};
};

export interface MachineCard {
	id: string;
	name: string;
	// host · SSH · status, or "this Mac".
	where: string;
	dot: 'good' | 'crit' | 'warn' | 'dim';
	counts: SessionCounts;
	// The first thing waiting there, as "store-front/wrk2: approve the migration?".
	waiting: string | null;
	detail: string | null;
	isRemote: boolean;
}

const STATUS_WORDS: Record<MachineStatus, string> = {
	connecting: 'connecting',
	syncing: 'catching up',
	connected: 'connected',
	unreachable: 'out of reach',
	error: 'needs a fix',
};

const describeFirstWaiting = (state: State, machine: string): string | null => {
	const ref = listWaitingRefs(state, machine)[0];
	const session = ref ? state.sessions[ref] : undefined;

	if (!ref || !session) {
		return null;
	}

	const ask = state.asks.find((pendingAsk) => pendingAsk.ref === ref);

	return `${session.label}: ${ask ? describeAsk(ask) : (session.needsUser?.text ?? 'needs you')}`;
};

const machineDot = (status: MachineStatus | 'local', isWaiting: boolean): MachineCard['dot'] => {
	if (isWaiting) {
		return 'crit';
	}

	if (status === 'local' || status === 'connected') {
		return 'good';
	}

	return status === 'unreachable' || status === 'error' ? 'warn' : 'dim';
};

// This Mac first, then each machine in the order they were added.
export const listMachineCards = (state: State): MachineCard[] => {
	const localWaiting = describeFirstWaiting(state, LOCAL_MACHINE);
	const local: MachineCard = {
		id: LOCAL_MACHINE,
		name: readMachineTitle(state, LOCAL_MACHINE),
		where: 'main · this Mac',
		dot: machineDot('local', localWaiting !== null),
		counts: countSessions(state, LOCAL_MACHINE),
		waiting: localWaiting,
		detail: null,
		isRemote: false,
	};
	const remotes = Object.values(state.machines).map((machine): MachineCard => {
		const waiting = describeFirstWaiting(state, machine.id);

		return {
			id: machine.id,
			name: machine.name,
			where: `${machine.host} · SSH · ${STATUS_WORDS[machine.status]}`,
			dot: machineDot(machine.status, waiting !== null),
			counts: countSessions(state, machine.id),
			waiting,
			detail: machine.detail,
			isRemote: true,
		};
	});

	return [local, ...remotes];
};

// A ref shown beside others from several machines: another machine's carries its name.
export const labelAcrossMachines = (state: State, ref: string, here: string | null): string => {
	const label = state.sessions[ref]?.label ?? ref;
	const name = readMachineName(state, ref);

	return name && readMachine(ref) !== here ? `${name} · ${label}` : label;
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
		note: `noted ${tail}`,
		hands_free: `turned hands-free ${tail}`,
	};

	return `${readableByName[name] ?? line}${isFailed ? ' — failed' : ''}`;
};

export const readNotesFor = (state: State, screen: string | null): string[] =>
	// Newest first, of the workspace on screen; Mission Control shows the general notes.
	[...(state.notes[readWorkspace(screen)] ?? [])].reverse();

const describeAsk = (ask: PendingAsk): string => {
	switch (ask.kind) {
		case 'permission':
			return `wants to ${ask.summary}`;
		case 'plan':
			return 'has a plan to approve';
		case 'command':
			return `waits on your yes to /${ask.command}`;
		case 'redirect':
			return 'waits on your yes to switch';
		case 'question':
			return ask.questions[0]?.question ?? 'has a question';
	}
};

// gridMachine: on a machine's grid, what the other machines have (its own sessions are the grid).
export const listOtherSessions = (
	state: State,
	screen: string | null,
	now: number,
	gridMachine?: string,
): OtherSessionRow[] => {
	const rows: OtherSessionRow[] = [];
	const here = gridMachine ?? (screen ? readMachine(screen) : null);

	for (const ref of state.order) {
		const session = state.sessions[ref];

		if (!session || ref === screen || (gridMachine && readMachine(ref) === gridMachine)) {
			continue;
		}

		const ask = state.asks.find((pendingAsk) => pendingAsk.ref === ref);
		const work = describeWork(session, now);

		const label = labelAcrossMachines(state, ref, here);

		if (ask || session.needsUser) {
			const text = ask ? describeAsk(ask) : (session.needsUser?.text ?? '');
			rows.push({ ref, label, isWaiting: true, text, age: work.waitingFor });
		} else if (work.for) {
			rows.push({
				ref,
				label,
				isWaiting: false,
				text: work.requests.at(-1) ?? session.topic ?? session.status,
				age: work.for,
			});
		}
	}

	return [...rows.filter((row) => row.isWaiting), ...rows.filter((row) => !row.isWaiting)];
};

// The session's docs, newest first, each once.
export const listDocs = (session: Pick<Session, 'stream'>): SessionDoc[] =>
	listSessionDocs(session.stream);
