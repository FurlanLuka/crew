// A session, full width: its header, the state row, then the stream and the side panels. On a
// desktop only the stream scrolls; the header, the panels and the voice bar stay put.
import { useState } from 'react';
import { isActive } from '../../shared/active.js';
import { readMachine, toLocalRef } from '../../shared/machine-ref.js';
import { readMachineTitle, readSessionLabel } from '../../shared/machines.js';
import type { Session, State } from '../../shared/protocol.js';
import { describeWork } from '../../state/working.js';
import {
	describeSessionBadge,
	findRunFor,
	isRunRunning,
	readRefTitle,
	readWorkingOn,
} from '../derive.js';
import { isOk, readCrewLine, runCrew, useCrew } from '../setup/api.js';
import { hasDevServers } from '../setup/derive.js';
import type { CrewMember, CrewProject } from '../setup/types.js';
import type { Dispatch } from '../types.js';
import { useNow } from '../use-now.js';
import { DevPanel } from './DevPanel.js';
import { DocsPanel } from './DocsPanel.js';
import { ElsewherePanel } from './ElsewherePanel.js';
import { NotesPanel } from './NotesPanel.js';
import { RenameSession } from './RenameSession.js';
import { SessionStateRow } from './SessionStateRow.js';
import { SessionStream } from './SessionStream.js';
import { SubagentDialog } from './SubagentDialog.js';
import { SubagentsPanel } from './SubagentsPanel.js';
import { VoicePanel } from './VoicePanel.js';

interface CockpitProps {
	session: Session;
	state: State;
	dispatch: Dispatch;
}

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

interface RemoveChatProps {
	session: Session;
	dispatch: Dispatch;
	// asking: the confirm shows; removing: crew runs; any other text: why it was not removed.
	state: string | null;
	onState: (state: string | null) => void;
}

// A plain session goes: its Claude stops, crew drops its record; the folder and the conversation's
// files stay where they are.
const RemoveChat = ({ session, dispatch, state, onState }: RemoveChatProps) => {
	const remove = async () => {
		onState('removing');
		dispatch({ type: 'deactivate', ref: session.ref });
		const reply = await runCrew(readMachine(session.ref), {
			type: 'chat_rm',
			id: toLocalRef(session.ref),
		});
		onState(isOk(reply) ? null : readCrewLine(reply) || 'Not removed.');
	};

	if (state === 'asking') {
		return (
			<>
				<button type="button" className="btn sm danger" onClick={() => void remove()}>
					Remove: its folder stays
				</button>
				<button type="button" className="btn sm ghost" onClick={() => onState(null)}>
					Keep it
				</button>
			</>
		);
	}

	return (
		<>
			<button
				type="button"
				className="btn sm ghost danger"
				disabled={state === 'removing'}
				onClick={() => onState('asking')}
			>
				Remove
			</button>
			{state && state !== 'removing' && <span className="m">{state}</span>}
		</>
	);
};

export const Cockpit = ({ session, state, dispatch }: CockpitProps) => {
	const [isRenaming, setIsRenaming] = useState(false);
	const [removal, setRemoval] = useState<'asking' | 'removing' | string | null>(null);
	const [openTaskId, setOpenTaskId] = useState<string | null>(null);
	const openRun = session.subagentRuns.find((run) => run.taskId === openTaskId) ?? null;
	const now = useNow();
	const isOn = isActive(state, session.ref);
	const workingOn = readWorkingOn(session);
	const badge = describeSessionBadge(session, state.asks);
	const work = describeWork(session, now);
	const machine = readMachine(session.ref);
	const servers = state.devServers[session.ref] ?? [];
	const isDevStarting = state.devStarting.includes(session.ref);
	// Running servers show even before crew's reads answer.
	const isDevShown = useHasDevServers(session) || servers.length > 0 || isDevStarting;
	const meta = [
		readMachineTitle(state, machine),
		session.label !== readSessionLabel(state, session.ref) ? session.label : '',
		`${badge.label}${work.for ? ` ${work.for}` : ''}`,
	]
		.filter(Boolean)
		.join(' · ');

	return (
		<section className="vo-view vo-session" aria-label="session">
			<div className="vo-head">
				<span className={`dot ${badge.dot}`} />
				{isRenaming ? (
					<RenameSession
						sessionRef={session.ref}
						current={readSessionLabel(state, session.ref)}
						dispatch={dispatch}
						onDone={() => setIsRenaming(false)}
					/>
				) : (
					<h1 title={readRefTitle(state, session.ref)}>{readSessionLabel(state, session.ref)}</h1>
				)}
				<span className="m">{meta}</span>
				<div className="row-actions">
					<button type="button" className="btn sm ghost rename" onClick={() => setIsRenaming(true)}>
						Rename
					</button>
					<button
						type="button"
						className="btn sm ghost toggle-active"
						onClick={() => dispatch({ type: isOn ? 'deactivate' : 'activate', ref: session.ref })}
					>
						{isOn ? 'Deactivate' : 'Activate'}
					</button>
					{session.isChat && (
						<RemoveChat
							session={session}
							dispatch={dispatch}
							state={removal}
							onState={setRemoval}
						/>
					)}
				</div>
			</div>
			<SessionStateRow state={state} sessionRef={session.ref} dispatch={dispatch} />
			<div className="vo-split">
				<SessionStream
					sessionRef={session.ref}
					session={session}
					className="vo-stream stream"
					openFor={(item) => {
						const run = item.kind === 'tool' ? findRunFor(session, item.toolUseId) : null;

						return run ? () => setOpenTaskId(run.taskId) : null;
					}}
				>
					{session.status === 'stopped' && !session.error && (
						<div className="line notice c-dim">
							{isOn
								? 'Not running yet.'
								: 'Not active: its history only. Voice OS runs no Claude here and says nothing about it.'}
						</div>
					)}
				</SessionStream>
				<aside className="vo-panels side">
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
					</div>
					<SubagentsPanel subagents={session.subagents} onOpen={setOpenTaskId} />
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
				</aside>
			</div>
			{openRun && (
				<SubagentDialog
					run={openRun}
					isRunning={isRunRunning(session, openRun)}
					onClose={() => setOpenTaskId(null)}
				/>
			)}
		</section>
	);
};
