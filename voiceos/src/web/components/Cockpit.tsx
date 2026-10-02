// A session, full width: its header, the state row, then the stream and the side panels. On a
// desktop only the stream scrolls; the header, the panels and the voice bar stay put.
import { useState } from 'react';
import { isActive } from '../../shared/active.js';
import { readMachine, toLocalRef } from '../../shared/machine-ref.js';
import { readMachineTitle, readSessionLabel } from '../../shared/machines.js';
import type { Session, State } from '../../shared/protocol.js';
import { stripStreamingTag } from '../../shared/spoken-tags.js';
import { describeWork } from '../../state/working.js';
import { describeSessionBadge, readRefTitle, readWorkingOn } from '../derive.js';
import { useCrew } from '../setup/api.js';
import { hasDevServers } from '../setup/derive.js';
import type { CrewMember, CrewProject } from '../setup/types.js';
import type { Dispatch } from '../types.js';
import { useNow } from '../use-now.js';
import { useStickToBottom } from '../use-stick-to-bottom.js';
import { CompactingLine } from './CompactingLine.js';
import { DevPanel } from './DevPanel.js';
import { DocsPanel } from './DocsPanel.js';
import { ElsewherePanel } from './ElsewherePanel.js';
import { Markdown } from './Markdown.js';
import { NotesPanel } from './NotesPanel.js';
import { RenameSession } from './RenameSession.js';
import { SessionStateRow } from './SessionStateRow.js';
import { StreamLine } from './StreamLine.js';
import { SubagentsPanel } from './SubagentsPanel.js';
import { VoicePanel } from './VoicePanel.js';

interface CockpitProps {
	session: Session;
	state: State;
	dispatch: Dispatch;
}

// Whether any of the worktree's projects has a dev server recorded, from crew.
const useHasDevServers = (session: Session): boolean => {
	const machine = readMachine(session.ref);
	const members = useCrew<CrewMember[]>(machine, { type: 'show', ref: toLocalRef(session.ref) });
	const projects = useCrew<CrewProject[]>(machine, { type: 'ls_projects' });

	return hasDevServers(members.data ?? [], projects.data ?? []);
};

export const Cockpit = ({ session, state, dispatch }: CockpitProps) => {
	// The compaction bar is added at the end of the stream too: it comes into view like a line.
	const streamRef = useStickToBottom<HTMLElement>(session.ref);
	const [isRenaming, setIsRenaming] = useState(false);
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
				</div>
			</div>
			<SessionStateRow state={state} sessionRef={session.ref} dispatch={dispatch} />
			<div className="vo-split">
				<section className="vo-stream stream" aria-label="stream" ref={streamRef}>
					{session.stream.map((item) => (
						<StreamLine key={item.id} item={item} />
					))}
					{stripStreamingTag(session.draft) && (
						<div className="line text">
							<Markdown text={stripStreamingTag(session.draft)} />
							<span className="caret" />
						</div>
					)}
					{session.compactingSince !== null && <CompactingLine since={session.compactingSince} />}
					{session.status === 'stopped' && !session.error && (
						<div className="line notice c-dim">
							{isOn
								? 'Not running yet.'
								: 'Not active: its history only. Voice OS runs no Claude here and says nothing about it.'}
						</div>
					)}
				</section>
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
					<SubagentsPanel subagents={session.subagents} />
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
		</section>
	);
};
