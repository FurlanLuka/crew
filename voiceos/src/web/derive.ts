import { readApprovalSummary } from '../shared/approval.js';
import { stripStreamingTag } from '../shared/spoken-tags.js';
import {
	isHeldAsk,
	type PendingAsk,
	type Session,
	type State,
	type SubagentItem,
	type SubagentRun,
} from '../shared/protocol.js';
import { listSessionDocs, type SessionDoc } from '../shared/session-docs.js';
import { hasBackgroundWork } from '../state/subagents.js';
import { describeWork, formatAge } from '../state/working.js';
import { stripMarkdown } from './markdown.js';
import { countOf } from './count.js';
import { countMachineRefs } from '../shared/active.js';
import { readWorkspace } from '../shared/notes.js';
import { isSetupRef, machineOf, readMachine } from '../shared/machine-ref.js';
import {
	isMachineReachable,
	isNamed,
	readMachineName,
	readMachineTitle,
	readSessionLabel,
} from '../shared/machines.js';

export interface Badge {
	dot: string;
	label: string;
	isAlarm: boolean;
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

// An active ref with no session: its machine is out of reach (it may come back), or the worktree is gone.
export const describeMissingActive = (state: State, ref: string): string => {
	const machine = machineOf(ref);
	const label = readSessionLabel(state, ref);

	if (machine && !isMachineReachable(state, machine)) {
		return `${label} · ${readMachineTitle(state, machine)} out of reach`;
	}

	return machine ? `${readMachineTitle(state, machine)} · ${label} · gone` : `${label} · gone`;
};

// A ref shown beside others from several machines: another machine's carries its name, unless the
// developer named the session (a name is chosen to stand alone).
export const labelAcrossMachines = (state: State, ref: string, here: string | null): string => {
	const label = readSessionLabel(state, ref);
	const name = readMachineName(state, ref);

	return name && !isNamed(state, ref) && readMachine(ref) !== here ? `${name} · ${label}` : label;
};

// The hover on a named session's label: the crew ref it stands for.
// What a session is working on: its last request while a turn runs (or waits on the developer);
// nothing once it is idle or stopped, where the request is history.
export const readWorkingOn = (session: Pick<Session, 'status' | 'requests'>): string | null =>
	session.status === 'running' || session.status === 'blocked'
		? (session.requests.at(-1)?.text ?? null)
		: null;

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
			tail === 'mission control' || tail === 'active' ? 'went to Active' : `opened ${tail}`,
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
	// Newest first, of the workspace on screen; Active and the other screens show the general notes.
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

export const listOtherSessions = (
	state: State,
	screen: string | null,
	now: number,
): OtherSessionRow[] => {
	const rows: OtherSessionRow[] = [];
	const here = screen ? readMachine(screen) : null;

	for (const ref of state.order) {
		const session = state.sessions[ref];

		// The setup sessions live in Set up: Voice OS never shows them.
		if (!session || ref === screen || isSetupRef(ref)) {
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

// What a machine holds, in a few words: Home's cards and the New menu say it the same way.
export const describeCounts = (state: State, machine: string): string => {
	const { worktrees, active, plain } = countMachineRefs(state, machine);

	return [
		countOf(worktrees, 'worktree'),
		`${active} active`,
		...(plain > 0 ? [`${plain} plain`] : []),
	].join(' · ');
};

// A session waiting on the developer: an ask, a confirm, a "needs you" line.
export const isWaiting = (state: State, ref: string): boolean => {
	const session = state.sessions[ref];

	return session ? describeSessionBadge(session, state.asks).isAlarm : false;
};
