// The machine's setup session in Set up's card, drawn with Voice OS's own session pieces: the stream
// (with a green "✓ recorded" under every crew command that recorded something), then at the card's
// foot its sub-agents, what it asks (options, your own words, ✕), the words queued while it works and
// a plain composer. Never spoken: voice neither hears it nor talks to it, and nothing here goes
// through the kernel.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { Action, StreamItem } from '../../shared/protocol.js';
import { AskDock } from '../components/AskDock.js';
import { QueueList } from '../components/QueueList.js';
import { SessionStream } from '../components/SessionStream.js';
import { SubagentsPanel } from '../components/SubagentsPanel.js';
import { readSessionAsk } from '../moments.js';
import type { SetupContext } from './common.js';
import { listRecordedLines } from './recorded.js';
import { setupRefFor } from './SetupShell.js';

interface SetupChatProps {
	ctx: SetupContext;
	// A request handed over from a Fix/Ask button: filled in, ready to send or edit.
	draft: string;
	onDraftUsed: () => void;
}

export const SetupChat = ({ ctx, draft, onDraftUsed }: SetupChatProps) => {
	const ref = setupRefFor(ctx.machine);
	const session = ctx.state.sessions[ref];
	const ask = readSessionAsk(ctx.state, ref);
	const [text, setText] = useState(draft);
	const fieldRef = useRef<HTMLInputElement | null>(null);
	const recorded = new Map(
		listRecordedLines(session?.stream ?? []).map((line) => [line.afterId, line.text]),
	);
	const isWorking = session?.status === 'running' || session?.status === 'blocked';
	const dispatch = (action: Action) => ctx.send({ type: 'action', action });

	useEffect(() => {
		if (draft) {
			onDraftUsed();
			fieldRef.current?.focus();
		}
	}, []);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		const words = text.trim();

		if (!words) {
			return;
		}

		// Straight to the setup session: busy, it waits in the queue below.
		dispatch({ type: 'send', ref, text: words });
		setText('');
	};

	const renderRecorded = (item: StreamItem) => {
		const line = recorded.get(item.id);

		return line ? <div className="rec-line">✓ recorded · {line}</div> : null;
	};

	return (
		<section className="page chatpage" aria-label="Setup with Claude">
			<div className="head-row">
				<div className="head-text">
					<h1>Setup with Claude</h1>
					<p className="lead">{ctx.machineTitle} · always on, one conversation</p>
				</div>
				{isWorking && (
					<div className="row-actions">
						<button
							type="button"
							className="btn"
							onClick={() => dispatch({ type: 'interrupt', ref })}
						>
							Stop
						</button>
					</div>
				)}
			</div>
			<div className="ss-main">
				<SessionStream
					sessionRef={ref}
					session={session}
					className="chat"
					renderAfter={renderRecorded}
				>
					{!session && (
						<p className="msg c-dim">
							Setup isn't running on {ctx.machineTitle} yet. Ask anything below and it starts: it
							reads your repos, records what it finds with crew commands, and asks you only what it
							can't know.
						</p>
					)}
					{session?.stream.length === 0 && !session.draft && (
						<p className="msg c-dim">
							Ask anything: add a project, fix a server, check this machine.
						</p>
					)}
				</SessionStream>
				<div className="ss-foot">
					{session && <SubagentsPanel subagents={session.subagents} />}
					{ask && <AskDock ask={ask} label="setup" dispatch={dispatch} />}
					{session && <QueueList session={session} dispatch={dispatch} />}
					<form className="reply" onSubmit={submit}>
						<input
							ref={fieldRef}
							type="text"
							placeholder="Reply to Claude, or ask anything…"
							aria-label="Reply to setup"
							autoComplete="off"
							value={text}
							onChange={(event) => setText(event.target.value)}
						/>
						<button type="submit" className="btn primary">
							{isWorking ? 'Queue' : 'Send'}
						</button>
					</form>
				</div>
			</div>
		</section>
	);
};
