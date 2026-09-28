import { stripStreamingTag } from '../../shared/spoken-tags.js';
import { useEffect, useRef } from 'react';
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

interface CockpitProps {
	session: Session;
	state: State;
	dispatch: Dispatch;
}

export const Cockpit = ({ session, state, dispatch }: CockpitProps) => {
	const streamEndRef = useRef<HTMLDivElement>(null);

	// The compaction bar is added at the end of the stream too: it must come into view like a line.
	useEffect(() => {
		streamEndRef.current?.scrollIntoView({ block: 'end' });
	}, [session.stream.length, session.draft, session.compactingSince]);

	return (
		<main className="cockpit">
			<section className="stream" aria-label="stream">
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
				{session.status === 'stopped' && (
					<div className="btns">
						<span className="c-dim">
							{session.error
								? `Stopped: ${session.error}`
								: 'Not running — your first message starts it.'}
						</span>
						<button
							type="button"
							className="btn primary"
							onClick={() => dispatch({ type: 'start_session', ref: session.ref })}
						>
							Start · “start {session.label}”
						</button>
					</div>
				)}
				<div ref={streamEndRef} />
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
						{session.status !== 'stopped' && (
							<button
								type="button"
								className="btn danger"
								onClick={() => dispatch({ type: 'stop_session', ref: session.ref })}
							>
								End session
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
				<div className="panel">
					<span className="lbl">topic</span>
					<div className="row">{session.topic ?? 'none yet'}</div>
				</div>
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
