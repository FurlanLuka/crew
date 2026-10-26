// What a session keeps beside its stream: the session itself, its sub-agents, other sessions' asks,
// dev servers, voice, notes, docs, elsewhere and where it runs. The desktop draws them beside the
// stream; a phone draws them full screen behind ⋯. useSessionDialogs is what opens from them (and
// from the stream): a sub-agent's transcript, an asked copy's steps.
import { type ReactNode, useState } from 'react';
import { readMachine, toLocalRef } from '../../shared/machine-ref.js';
import { readSessionLabel } from '../../shared/machines.js';
import type { PeerRun, Session, State, StreamItem } from '../../shared/protocol.js';
import { findPeerRun } from '../../state/peer-runs.js';
import { findRunFor, isRunRunning, readWorkingOn } from '../derive.js';
import { useCrew } from '../setup/api.js';
import { hasDevServers } from '../setup/derive.js';
import type { CrewMember, CrewProject } from '../setup/types.js';
import type { Dispatch } from '../types.js';
import { DevPanel } from './DevPanel.js';
import { DocsPanel } from './DocsPanel.js';
import { ElsewherePanel } from './ElsewherePanel.js';
import { NotesPanel } from './NotesPanel.js';
import { PeerRunDialog } from './PeerRunDialog.js';
import { PeerRunsPanel } from './PeerRunsPanel.js';
import { SubagentDialog } from './SubagentDialog.js';
import { SubagentsPanel } from './SubagentsPanel.js';
import { VoicePanel } from './VoicePanel.js';

// Whether any of the worktree's projects has a dev server recorded, from crew. A plain session has no
// worktree to ask about.
const useHasDevServers = (session: Session): boolean => {
	const machine = readMachine(session.ref);
	const members = useCrew<CrewMember[]>(
		machine,
		session.isChat ? null : { type: 'show', ref: toLocalRef(session.ref) },
	);
	const projects = useCrew<CrewProject[]>(machine, session.isChat ? null : { type: 'ls_projects' });

	return hasDevServers(members.data ?? [], projects.data ?? []);
};

interface PeerOpen {
	ref: string;
	requestId: string;
}

export interface SessionDialogs {
	openTask: (taskId: string) => void;
	openPeer: (open: PeerOpen) => void;
	// What clicking a stream item opens, if anything.
	openFor: (item: StreamItem) => (() => void) | null;
	peerRunFor: (item: StreamItem) => PeerRun | null;
	dialogs: ReactNode;
}

export const useSessionDialogs = (session: Session, state: State): SessionDialogs => {
	const [openTaskId, setOpenTaskId] = useState<string | null>(null);
	const openRun = session.subagentRuns.find((run) => run.taskId === openTaskId) ?? null;
	// A copy's steps: this session's own (another session asked it) or the asked session's (it asked).
	const [openPeer, setOpenPeer] = useState<PeerOpen | null>(null);
	const openPeerRun = openPeer
		? findPeerRun(state.sessions[openPeer.ref], openPeer.requestId)
		: undefined;
	const peerRunFor = (item: StreamItem) =>
		item.kind === 'session_ask' && item.peerRef
			? (findPeerRun(state.sessions[item.peerRef], item.requestId) ?? null)
			: null;

	const openFor = (item: StreamItem) => {
		if (item.kind === 'session_ask') {
			const peerRef = item.peerRef;

			return peerRef && item.request === 'ask' && peerRunFor(item)
				? () => setOpenPeer({ ref: peerRef, requestId: item.requestId })
				: null;
		}

		const run = item.kind === 'tool' ? findRunFor(session, item.toolUseId) : null;

		return run ? () => setOpenTaskId(run.taskId) : null;
	};

	const dialogs = (
		<>
			{openPeer && openPeerRun && (
				<PeerRunDialog
					run={openPeerRun}
					sessionLabel={readSessionLabel(state, openPeer.ref)}
					onClose={() => setOpenPeer(null)}
				/>
			)}
			{openRun && (
				<SubagentDialog
					run={openRun}
					isRunning={isRunRunning(session, openRun)}
					onClose={() => setOpenTaskId(null)}
				/>
			)}
		</>
	);

	return { openTask: setOpenTaskId, openPeer: setOpenPeer, openFor, peerRunFor, dialogs };
};

interface SessionPanelsProps {
	session: Session;
	state: State;
	dispatch: Dispatch;
	dialogs: SessionDialogs;
	// Drawn at the end of the Session panel: on a phone, the mode, model and context chips.
	sessionExtra?: ReactNode;
}

export const SessionPanels = ({
	session,
	state,
	dispatch,
	dialogs,
	sessionExtra,
}: SessionPanelsProps) => {
	const workingOn = readWorkingOn(session);
	const servers = state.devServers[session.ref] ?? [];
	const isDevStarting = state.devStarting.includes(session.ref);
	// Running servers show even before crew's reads answer.
	const isDevShown = useHasDevServers(session) || servers.length > 0 || isDevStarting;

	return (
		<>
			<div className="vo-panel panel">
				<span className="label">Session</span>
				<div className="kv">
					<span>status</span>
					<b>{session.status}</b>
				</div>
				<div className="kv">
					<span>cost</span>
					<b>${session.costUsd.toFixed(2)}</b>
				</div>
				{workingOn && <p className="m">working on: {workingOn}</p>}
				{(session.status === 'running' || session.status === 'blocked') && (
					<div className="row-actions">
						<button
							type="button"
							className="btn sm"
							onClick={() => dispatch({ type: 'interrupt', ref: session.ref })}
						>
							Stop turn · “stop”
						</button>
					</div>
				)}
				{sessionExtra}
			</div>
			<SubagentsPanel subagents={session.subagents} onOpen={dialogs.openTask} />
			<PeerRunsPanel
				runs={session.peerRuns}
				onOpen={(requestId) => dialogs.openPeer({ ref: session.ref, requestId })}
			/>
			{isDevShown && (
				<DevPanel
					worktree={session.ref}
					servers={servers}
					isStarting={isDevStarting}
					offer={state.devOffer}
					dispatch={dispatch}
				/>
			)}
			<VoicePanel state={state} screen={session.ref} />
			<NotesPanel state={state} screen={session.ref} />
			<DocsPanel session={session} />
			<ElsewherePanel state={state} screen={session.ref} dispatch={dispatch} />
			<div className="vo-panel panel">
				<span className="label">Where</span>
				<p className="m">{session.cwd}</p>
				{session.dirs.map((dir) => (
					<p key={dir} className="m">
						{dir}
					</p>
				))}
			</div>
		</>
	);
};
