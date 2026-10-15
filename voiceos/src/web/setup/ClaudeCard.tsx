// The board's Setup with Claude box: what it is doing, or a line to ask it, with the "@" menu of this
// machine's worktrees and projects. A worktree named in the question shows beside the chat at once.
import { type FormEvent, useRef, useState } from 'react';
import type { SetupContext } from './common.js';
import { findRefIn } from './focus.js';
import { MentionMenu } from './MentionMenu.js';
import { isSetupBusy, setupRefFor } from './SetupShell.js';
import { useMentions } from './use-mentions.js';

interface ClaudeCardProps {
	ctx: SetupContext;
	// This machine's worktrees and projects, as crew names them: what "@" offers.
	worktrees: string[];
	projects: string[];
}

export const ClaudeCard = ({ ctx, worktrees, projects }: ClaudeCardProps) => {
	const [text, setText] = useState('');
	const fieldRef = useRef<HTMLInputElement | null>(null);
	const ref = setupRefFor(ctx.machine);
	const session = ctx.state.sessions[ref];
	const isBusy = isSetupBusy(ctx.state, ref);
	const hasAsk = ctx.state.asks.some((ask) => ask.ref === ref);
	const mentions = useMentions({ text, setText, fieldRef, worktrees, projects });

	const submit = (event: FormEvent) => {
		event.preventDefault();
		const words = text.trim();

		if (words) {
			ctx.tellClaude(words, findRefIn(words, worktrees) ?? undefined);
		}
	};

	if (isBusy) {
		return (
			<div className="claude-card">
				<div className="cc-head">
					<span className={`dot ${hasAsk ? 'ask' : 'run'}`} />
					<b>Setup with Claude</b>
					<span className="m">{hasAsk ? 'waiting on you' : 'working'}</span>
					<button type="button" className="btn sm primary" onClick={() => ctx.go({ page: 'chat' })}>
						Open
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="claude-card">
			<div className="cc-head">
				<span className={`dot ${session ? 'ok' : 'ring'}`} />
				<b>Setup with Claude</b>
				{!session && <span className="m">starts when you ask</span>}
				<button type="button" className="btn sm ghost" onClick={() => ctx.go({ page: 'chat' })}>
					Open
				</button>
			</div>
			<form className="cc-input" onSubmit={submit}>
				<MentionMenu mentions={mentions} isBelow onPicked={() => fieldRef.current?.focus()} />
				<input
					ref={fieldRef}
					type="text"
					placeholder="Ask setup anything: add a project, fix a server, check this machine… @ names a worktree"
					aria-label="Ask setup"
					autoComplete="off"
					value={text}
					onChange={(event) => {
						setText(event.target.value);
						mentions.follow(event);
					}}
					onSelect={mentions.follow}
					onKeyDown={(event) => {
						mentions.handleKey(event);
					}}
				/>
				<button type="submit" className="btn sm primary">
					Ask
				</button>
			</form>
		</div>
	);
};
