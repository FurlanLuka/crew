// The machine's setup session in Set up's card, drawn with Voice OS's own session pieces: the stream
// (with a green "✓ recorded" under every crew command that recorded something), then at the card's
// foot its sub-agents, what it asks (options, your own words, ✕), the words queued while it works and
// a plain composer with an "@" menu of this machine's worktrees and projects. Beside it, the
// worktree it is on (focus.ts): its servers live while Claude works on them. Never spoken: voice
// neither hears it nor talks to it, and nothing here goes through the kernel.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { Action, StreamItem } from '../../shared/protocol.js';
import { AskDock } from '../components/AskDock.js';
import { AttachButton, AttachmentChips } from '../components/AttachmentChips.js';
import { ATTACHED_ONLY_TEXT, useAttachments } from '../use-attachments.js';
import { SlashMenu } from '../components/SlashMenu.js';
import { useSlashCommands } from '../use-slash-commands.js';
import { QueueList } from '../components/QueueList.js';
import { SessionStream } from '../components/SessionStream.js';
import { SubagentsPanel } from '../components/SubagentsPanel.js';
import { readSessionAsk } from '../moments.js';
import { useCrew } from './api.js';
import type { SetupContext } from './common.js';
import { isCheckRef } from './derive.js';
import { type AskedFocus, findFocus, pickFocus } from './focus.js';
import { MentionMenu } from './MentionMenu.js';
import { listRecordedLines } from './recorded.js';
import { setupRefFor } from './SetupShell.js';
import type { CrewProject, CrewWorktree } from './types.js';
import { useMentions } from './use-mentions.js';
import { WorktreePanel } from './WorktreePanel.js';

const LIST_POLL_MS = 10000;

interface SetupChatProps {
	ctx: SetupContext;
	// A request handed over from a Fix/Ask button: filled in, ready to send or edit.
	draft: string;
	onDraftUsed: () => void;
	askedFocus: AskedFocus | null;
}

export const SetupChat = ({ ctx, draft, onDraftUsed, askedFocus }: SetupChatProps) => {
	const ref = setupRefFor(ctx.machine);
	const session = ctx.state.sessions[ref];
	const ask = readSessionAsk(ctx.state, ref);
	const [text, setText] = useState(draft);
	const fieldRef = useRef<HTMLInputElement | null>(null);
	const recorded = new Map(
		listRecordedLines(session?.stream ?? []).map((line) => [line.afterId, line.text]),
	);
	const isWorking = session?.status === 'running' || session?.status === 'blocked';
	const worktrees = useCrew<CrewWorktree[]>(
		ctx.machine,
		{ type: 'ls_worktrees' },
		{ pollMs: LIST_POLL_MS },
	);
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const refs = (worktrees.data ?? []).map((row) => row.ref).filter((ref) => !isCheckRef(ref));
	const found = findFocus({ stream: session?.stream ?? [], refs });
	const [closedAt, setClosedAt] = useState<string | null>(null);
	const focus = pickFocus({ found, asked: askedFocus, closedAt });
	const mentions = useMentions({
		text,
		setText,
		fieldRef,
		worktrees: refs,
		projects: (projects.data ?? []).map((project) => project.name),
	});
	const dispatch = (action: Action) => ctx.send({ type: 'action', action });
	const attachments = useAttachments({
		state: ctx.state,
		sessionRef: session ? ref : null,
		send: ctx.send,
	});

	// Taken whenever it arrives: a "Fix with Claude" from outside Set up lands while the chat is
	// already open.
	useEffect(() => {
		if (draft) {
			setText(draft);
			onDraftUsed();
			fieldRef.current?.focus();
		}
	}, [draft]);

	const slash = useSlashCommands({
		state: ctx.state,
		sessionRef: session ? ref : null,
		text,
		setText,
		send: ctx.send,
	});

	const submit = (event: FormEvent) => {
		event.preventDefault();
		const words = text.trim();

		if (slash.runTyped(words)) {
			setText('');

			return;
		}

		// Files still uploading would be left behind: the button waits for them.
		if ((!words && attachments.waiting.length === 0) || attachments.isUploading) {
			return;
		}

		// Straight to the setup session: busy, it waits in the queue below.
		dispatch({ type: 'send', ref, text: words || ATTACHED_ONLY_TEXT });
		setText('');
	};

	const renderRecorded = (item: StreamItem) => {
		const line = recorded.get(item.id);

		return line ? <div className="rec-line">✓ recorded · {line}</div> : null;
	};

	return (
		<div className={`chat-layout ${focus ? 'with-panel' : ''}`}>
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
						hasAsk={ask !== null}
					>
						{!session && (
							<p className="msg c-dim">
								Setup isn't running on {ctx.machineTitle} yet. Ask anything below and it starts: it
								reads your repos, records what it finds with crew commands, and asks you only what
								it can't know.
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
						<AttachmentChips attachments={attachments} />
						<form className="reply" onSubmit={submit}>
							<SlashMenu slash={slash} onPicked={() => fieldRef.current?.focus()} />
							<MentionMenu mentions={mentions} onPicked={() => fieldRef.current?.focus()} />
							<input
								ref={fieldRef}
								type="text"
								placeholder="Reply to Claude, or ask anything…"
								aria-label="Reply to setup"
								autoComplete="off"
								value={text}
								onChange={(event) => {
									setText(event.target.value);
									mentions.follow(event);
								}}
								onSelect={mentions.follow}
								onKeyDown={(event) => {
									// One menu at a time: the slash menu's keys first.
									if (!slash.handleKey(event)) {
										mentions.handleKey(event);
									}
								}}
							/>
							{attachments.ref && <AttachButton attachments={attachments} />}
							<button type="submit" className="btn primary" disabled={attachments.isUploading}>
								{isWorking ? 'Queue' : 'Send'}
							</button>
						</form>
					</div>
				</div>
			</section>
			{focus && (
				<WorktreePanel
					key={focus.ref}
					ctx={ctx}
					worktreeRef={focus.ref}
					projects={projects.data ?? []}
					onClose={() => setClosedAt(focus.closeKey)}
				/>
			)}
		</div>
	);
};
