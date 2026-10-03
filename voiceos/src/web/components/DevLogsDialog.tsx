// A dev server's log, from the session page: what `crew dev logs` prints on the session's machine,
// followed every 2 s. A real modal like the sub-agent transcript: Esc closes it (the dialog's own
// cancel), and the page's own Esc and Space leave it alone.
import { useState } from 'react';
import { readMachine, toLocalRef } from '../../shared/machine-ref.js';
import type { DevServer } from '../../shared/protocol.js';
import { useCrew } from '../setup/api.js';
import { readLogText } from '../setup/readers.js';
import type { Dispatch } from '../types.js';
import { useStickToBottom } from '../use-stick-to-bottom.js';

const FOLLOW_MS = 2000;
const LOG_LINES = 200;
const COPIED_MS = 1500;

// A display hint only: the words a failing server's output tends to carry.
// "KeyError" and "TypeError" count, "errors=0" does not.
const ERROR_WORDS = /\b\w*(error|exception)\b|\b(traceback|failed|fatal|panic)\b|ECONNREFUSED/i;

export const isErrorLine = (line: string): boolean => ERROR_WORDS.test(line);

interface DevLogsDialogProps {
	worktree: string;
	// Every server of the worktree, one tab each; the one clicked opens first.
	servers: DevServer[];
	first: string;
	dispatch: Dispatch;
	onClose: () => void;
}

export const DevLogsDialog = ({
	worktree,
	servers,
	first,
	dispatch,
	onClose,
}: DevLogsDialogProps) => {
	const [shown, setShown] = useState(first);
	const [isFollowing, setIsFollowing] = useState(true);
	const [isCopied, setIsCopied] = useState(false);
	// A server gone from crew's list since (stopped meanwhile) falls back to the first one there is.
	const server = servers.find((candidate) => candidate.name === shown) ?? servers[0];
	const log = useCrew<unknown>(
		readMachine(worktree),
		server
			? { type: 'dev_logs', ref: toLocalRef(worktree), server: server.name, lines: LOG_LINES }
			: null,
		isFollowing ? { pollMs: FOLLOW_MS } : {},
	);
	// Until the new tab's first read lands, the last reply is another server's: never shown under this one.
	const isThisServer = (log.data as { server?: unknown } | null)?.server === server?.name;
	const text = isThisServer ? readLogText(log.data) : '';
	const lines = text ? text.split('\n') : [];
	// Keyed by server only: it follows new lines itself, and a reader scrolled up stays where they are.
	const listRef = useStickToBottom<HTMLDivElement>(server?.name ?? '');
	const failure = log.reply && !log.isLoading && !text ? log.reply.stderr.trim() : '';

	if (!server) {
		return null;
	}

	const isRunning = server.state === 'running';

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), COPIED_MS);
		} catch {
			// No clipboard here (an insecure origin): the lines can still be selected by hand.
		}
	};

	return (
		<dialog
			className="sd"
			aria-label="dev server logs"
			ref={(dialog) => {
				if (dialog && !dialog.open) {
					dialog.showModal();
				}
			}}
			onClose={onClose}
		>
			<div className="sd-head">
				<span className="sd-kicker">dev server · {worktree}</span>
				<h2>
					{server.name} <span className={isRunning ? 'c-good' : 'c-crit'}>· {server.state}</span>
				</h2>
				<p className="sd-task">
					{server.url ? server.url.replace(/^https?:\/\//, '') : `port ${server.port}`} ·{' '}
					{isFollowing ? 'following, new lines as they come' : 'paused'}
				</p>
				{servers.length > 1 && (
					<div className="seg dl-tabs" role="tablist" aria-label="Server">
						{servers.map((candidate) => (
							<button
								key={candidate.name}
								type="button"
								role="tab"
								aria-selected={candidate.name === server.name}
								onClick={() => setShown(candidate.name)}
							>
								<span className={`dot ${candidate.state === 'running' ? 'ok' : 'ask'}`} />
								{candidate.name}
							</button>
						))}
					</div>
				)}
			</div>
			<div className="sd-lines dl-lines" ref={listRef}>
				{lines.length === 0 && (
					<div className="c-dim">
						{failure || (log.isLoading ? 'Reading the log…' : 'No output yet.')}
					</div>
				)}
				{lines.map((line, index) => (
					// Lines repeat and have no ids: an index key costs only re-rendering the rows that shifted.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above
					<div key={index} className={isErrorLine(line) ? 'c-crit' : undefined}>
						{line}
					</div>
				))}
			</div>
			<div className="sd-actions dl-actions">
				<button
					type="button"
					className="btn sm ghost"
					aria-pressed={!isFollowing}
					onClick={() => setIsFollowing(!isFollowing)}
				>
					{isFollowing ? 'Pause' : 'Follow'}
				</button>
				<button type="button" className="btn sm ghost" disabled={!text} onClick={() => void copy()}>
					{isCopied ? 'Copied' : 'Copy'}
				</button>
				<span className="dl-gap" />
				{/* crew restarts a worktree's servers together: there is no one-server restart. */}
				<button
					type="button"
					className="btn sm"
					onClick={() => dispatch({ type: 'dev_restart', ref: worktree })}
				>
					Restart dev servers
				</button>
				<button type="button" className="btn sm" onClick={onClose}>
					Close
				</button>
			</div>
		</dialog>
	);
};
