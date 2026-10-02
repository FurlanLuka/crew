import { readApprovalSummary } from '../shared/approval.js';
import { stripStreamingTag } from '../shared/spoken-tags.js';
import {
	isHeldAsk,
	type MachineStatus,
	type PendingAsk,
	type Session,
	type State,
	type View,
	type SubagentItem,
	type SubagentRun,
} from '../shared/protocol.js';
import { listSessionDocs, type SessionDoc } from '../shared/session-docs.js';
import { hasBackgroundWork } from '../state/subagents.js';
import { describeWork, formatAge } from '../state/working.js';
import { stripMarkdown } from './markdown.js';
import { readWorkspace } from '../shared/notes.js';
import { isActive, listActiveMissing, listActiveRefs } from '../shared/active.js';
import { LOCAL_MACHINE, machineOf, readMachine } from '../shared/machine-ref.js';
import {
	currentMachine,
	isMachineReachable,
	isNamed,
	listMachineRefs,
	listWaitingRefs,
	readMachineName,
	readMachineTitle,
	readSessionLabel,
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

// label: what the session is called on screen, for the line that says how to activate it.
// isSessionActive: an active one stopped (a crash, its machine away) needs no "activate".
export const readLastLine = (session: Session, label: string, isSessionActive: boolean): string => {
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

	if (session.status !== 'stopped') {
		return '';
	}

	return isSessionActive ? 'Not running.' : `Not running. Activate it, or say “activate ${label}”.`;
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

// here: the machine the line is shown in; null where every machine's sessions sit together.
const describeFirstWaiting = (
	state: State,
	waitingRefs: string[],
	here: string | null,
): string | null => {
	const ref = waitingRefs[0];
	const session = ref ? state.sessions[ref] : undefined;

	if (!ref || !session) {
		return null;
	}

	const ask = state.asks.find((pendingAsk) => pendingAsk.ref === ref);

	return `${labelAcrossMachines(state, ref, here)}: ${ask ? describeAsk(ask) : (session.needsUser?.text ?? 'needs you')}`;
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
	const localWaiting = describeFirstWaiting(
		state,
		listWaitingRefs(state, LOCAL_MACHINE),
		LOCAL_MACHINE,
	);
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
		const waiting = describeFirstWaiting(state, listWaitingRefs(state, machine.id), machine.id);

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

// Active, and a session opened from it: the active sessions stand in for a machine's sessions there.
export const isInsideActive = (view: View): boolean =>
	view.kind === 'active' || (view.kind === 'session' && view.from === 'active');

// Only the active sessions that are here count; one out of reach is a placeholder, not a session.
export const countActive = (state: State): SessionCounts => {
	const refs = listActiveRefs(state);
	const waiting = new Set(listWaitingRefs(state));

	return {
		total: refs.length,
		running: refs.filter((ref) => state.sessions[ref]?.status === 'running').length,
		waiting: refs.filter((ref) => waiting.has(ref)).length,
	};
};

// What the top bar counts over: the active sessions inside Active, else one machine's (none: all).
export type CountScope = 'active' | { machine?: string };

// The waiting updates in scope; a session already counted as waiting on you is not an update as well.
export const countUpdates = (state: State, scope: CountScope): number => {
	const machine = scope === 'active' ? undefined : scope.machine;
	const waiting = new Set(listWaitingRefs(state, machine));
	const isInScope = (ref: string): boolean =>
		scope === 'active'
			? isActive(state, ref)
			: machine === undefined || readMachine(ref) === machine;

	return state.meanwhile.filter((item) => isInScope(item.ref) && !waiting.has(item.ref)).length;
};

export interface ActiveCard {
	counts: SessionCounts;
	waiting: string | null;
}

export const describeActiveCard = (state: State): ActiveCard => ({
	counts: countActive(state),
	waiting: describeFirstWaiting(
		state,
		listWaitingRefs(state).filter((ref) => isActive(state, ref)),
		null,
	),
});

export type ActiveTile = { ref: string; session: Session } | { ref: string; missing: string };

// An active ref with no session: its machine is out of reach (it may come back), or the worktree is gone.
export const describeMissingActive = (state: State, ref: string): string => {
	const machine = machineOf(ref);
	const label = readSessionLabel(state, ref);

	if (machine && !isMachineReachable(state, machine)) {
		return `${label} · ${readMachineTitle(state, machine)} out of reach`;
	}

	return machine ? `${readMachineTitle(state, machine)} · ${label} · gone` : `${label} · gone`;
};

// The active sessions from every machine, setup first, then a placeholder for each active ref whose
// session is not here.
export const listActiveTiles = (state: State): ActiveTile[] => [
	...listActiveRefs(state).flatMap((ref) => {
		const session = state.sessions[ref];

		return session ? [{ ref, session }] : [];
	}),
	...listActiveMissing(state).map((ref) => ({ ref, missing: describeMissingActive(state, ref) })),
];

// Inside Active the tabs are the active sessions; inside a machine its sessions; elsewhere every session.
export const listTabRefs = (state: State): string[] => {
	if (isInsideActive(state.view)) {
		return listActiveRefs(state);
	}

	const machine = currentMachine(state);

	return machine ? state.order.filter((ref) => readMachine(ref) === machine) : state.order;
};

// Whose sessions labels are read against: none inside Active, where every machine's sit together.
export const readLabelMachine = (state: State): string | null =>
	isInsideActive(state.view) ? null : currentMachine(state);

// A ref shown beside others from several machines: another machine's carries its name, unless the
// developer named the session (a name is chosen to stand alone).
export const labelAcrossMachines = (state: State, ref: string, here: string | null): string => {
	const label = readSessionLabel(state, ref);
	const name = readMachineName(state, ref);

	return name && !isNamed(state, ref) && readMachine(ref) !== here ? `${name} · ${label}` : label;
};

// The hover on a named session's label: the crew ref it stands for.
export const readRefTitle = (state: State, ref: string): string | undefined =>
	isNamed(state, ref) ? ref : undefined;

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
		switch_view:
			tail === 'mission control'
				? 'went to Mission Control'
				: tail === 'active'
					? 'went to Active'
					: `opened ${tail}`,
		activate: `activated ${tail}`,
		// No ref: the session that was on screen.
		deactivate: `deactivated ${tail || 'this session'}`,
		crew_dev: `dev servers: ${tail}`,
		answer: `answered ${tail}`,
		interrupt: `stopped ${tail}'s turn`,
		mute: 'went quiet',
		dev_offer: `${rest[0] === 'accepted' ? 'accepted' : 'declined'} the fix offer`,
		allow_denied: `allowed ${tail} once`,
		debug_note: `noted for debugging ${tail}`,
		note: `noted ${tail}`,
		hands_free: `listening: ${tail || 'changed'}`,
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
				text: work.requests.at(-1) ?? session.status,
				age: work.for,
			});
		}
	}

	return [...rows.filter((row) => row.isWaiting), ...rows.filter((row) => !row.isWaiting)];
};

// The session's docs, newest first, each once.
export const listDocs = (session: Pick<Session, 'stream'>): SessionDoc[] =>
	listSessionDocs(session.stream);

// A sub-agent's transcript, by the Agent call that started it: its row in the history opens it.
export const findRunFor = (
	session: Pick<Session, 'subagentRuns'>,
	toolUseId: string | undefined,
): SubagentRun | null =>
	toolUseId === undefined
		? null
		: (session.subagentRuns.find((run) => run.toolUseId === toolUseId) ?? null);

export const isRunRunning = (session: Pick<Session, 'subagents'>, run: SubagentRun): boolean =>
	session.subagents.some((subagent) => subagent.taskId === run.taskId);

export const describeRunStatus = (run: SubagentRun, isRunning: boolean, now: number): string =>
	isRunning ? `running · ${formatAge(now - run.startedAt)}` : 'done';

// Its last words are what it hands back: once it has ended on text, that text is its report and is
// not shown again among its lines. One that ended on a call or a result (killed, failed) has none.
export const splitRunReport = (
	run: SubagentRun,
	isRunning: boolean,
): { lines: SubagentItem[]; report: string | null } => {
	const last = run.items.at(-1);

	return !isRunning && last?.kind === 'text'
		? { lines: run.items.slice(0, -1), report: last.text }
		: { lines: run.items, report: null };
};
