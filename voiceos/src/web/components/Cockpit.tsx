import { isActive } from '../../shared/active.js';
import { SETUP_REF } from '../../shared/machine-ref.js';
import { stripStreamingTag } from '../../shared/spoken-tags.js';
import { readSessionLabel } from '../../shared/machines.js';
import type { Session, State } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { CompactingLine } from './CompactingLine.js';
import { DevPanel } from './DevPanel.js';
import { ElsewherePanel } from './ElsewherePanel.js';
import { Markdown } from './Markdown.js';
import { StreamLine } from './StreamLine.js';
import { SubagentsPanel } from './SubagentsPanel.js';
import { NotesPanel } from './NotesPanel.js';
import { DocsPanel } from './DocsPanel.js';
import { VoicePanel } from './VoicePanel.js';
import { useStickToBottom } from '../use-stick-to-bottom.js';

interface CockpitProps {
	session: Session;
	state: State;
	dispatch: Dispatch;
}

export const Cockpit = ({ session, state, dispatch }: CockpitProps) => {
	// The compaction bar is added at the end of the stream too: it comes into view like a line.
	const streamRef = useStickToBottom<HTMLElement>(session.ref);
	const isOn = isActive(state, session.ref);

	return (
		<main className="cockpit">
			<section className="stream" aria-label="stream" ref={streamRef}>
				<span className="lbl">stream</span>
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
				{/* Inactive: the bottom bar's Activate stands where the input would be. Active and stopped
				(a crash): activating starts it again. */}
				{session.status === 'stopped' && (
					<div className="btns">
						<span className="c-dim">
							{session.error
								? `Stopped: ${session.error}`
								: isOn
									? 'Not running yet.'
									: 'Not active: its history only. Voice OS runs no Claude here and says nothing about it.'}
						</span>
						{isOn && (
							<button
								type="button"
								className="btn primary"
								onClick={() => dispatch({ type: 'activate', ref: session.ref })}
							>
								Start · “activate {readSessionLabel(state, session.ref)}”
							</button>
						)}
					</div>
				)}
			</section>
			<aside className="side">
				<div className="panel">
					<span className="lbl">session</span>
					<div className="row">
						status <span className="el">{session.status}</span>
					</div>
					<div className="row">
						cost <span className="el">${session.costUsd.toFixed(2)}</span>
					</div>
					{session.requests.length > 0 && (
						<div className="row c-dim">working on: {session.requests.at(-1)?.text}</div>
					)}
					<div className="btns">
						{(session.status === 'running' || session.status === 'blocked') && (
							<button
								type="button"
								className="btn"
								onClick={() => dispatch({ type: 'interrupt', ref: session.ref })}
							>
								Stop turn · “stop”
							</button>
						)}
						{/* This Mac's setup session is always active. */}
						{isOn && session.ref !== SETUP_REF && (
							<button
								type="button"
								className="btn danger"
								onClick={() => dispatch({ type: 'deactivate', ref: session.ref })}
							>
								Deactivate
							</button>
						)}
					</div>
				</div>
				<SubagentsPanel subagents={session.subagents} />
				{/* The setup session has no worktree, so no dev servers to start. */}
				{!session.isPinned && (
					<DevPanel
						worktree={session.ref}
						servers={state.devServers[session.ref] ?? []}
						isStarting={state.devStarting.includes(session.ref)}
						offer={state.devOffer}
						dispatch={dispatch}
					/>
				)}
				<VoicePanel state={state} screen={session.ref} />
				<NotesPanel state={state} screen={session.ref} />
				<DocsPanel session={session} />
				<ElsewherePanel state={state} screen={session.ref} dispatch={dispatch} />
				<div className="panel">
					<span className="lbl">where</span>
					<div className="row">{session.cwd}</div>
					{session.dirs.map((dir) => (
						<div key={dir} className="row c-dim">
							{dir}
						</div>
					))}
				</div>
			</aside>
		</main>
	);
};
