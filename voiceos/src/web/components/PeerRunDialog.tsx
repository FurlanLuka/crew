// The copy that answered another session's ask, step by step: what it read and searched, what it
// said along the way, and the answer that went back. Opened from the asked session's side panel or
// from View steps on the asking card. The same modal as a sub-agent's transcript.
import type { PeerRun } from '../../shared/protocol.js';
import { formatAge } from '../../state/working.js';
import { describePeerRunStatus } from '../derive.js';
import { useNow } from '../use-now.js';
import { useStickToBottom } from '../use-stick-to-bottom.js';
import { Markdown } from './Markdown.js';
import { StreamLine } from './StreamLine.js';

const ELAPSED_TICK_MS = 1000;

interface PeerRunDialogProps {
	run: PeerRun;
	// The asked session: the one the copy was made of.
	sessionLabel: string;
	onClose: () => void;
}

export const PeerRunDialog = ({ run, sessionLabel, onClose }: PeerRunDialogProps) => {
	const now = useNow(ELAPSED_TICK_MS);
	const listRef = useStickToBottom<HTMLDivElement>(run.requestId);
	const status =
		run.settledAt === null
			? `${describePeerRunStatus(run)} · ${formatAge(now - run.startedAt)}`
			: `${describePeerRunStatus(run)} in ${formatAge(run.settledAt - run.startedAt)}`;

	return (
		<dialog
			className="sd"
			aria-label="steps of a copy answering another session"
			ref={(dialog) => {
				if (dialog && !dialog.open) {
					dialog.showModal();
				}
			}}
			onClose={onClose}
		>
			<div className="sd-head">
				<span className="sd-kicker">question from {run.fromLabel}</span>
				<h2>
					A copy of {sessionLabel} <span className="sd-status">· {status}</span>
				</h2>
				<p className="sd-task">{run.text}</p>
			</div>
			<div className="sd-lines" ref={listRef}>
				{run.items.length === 0 && run.answer === null && (
					<div className="line c-dim">Nothing yet.</div>
				)}
				{run.items.map((item) => (
					<StreamLine key={item.id} item={item} />
				))}
				{run.answer !== null && (
					<section className="sd-report" aria-label="answer">
						<span className="sd-kicker">
							{run.status === 'answered'
								? `answer · sent back to ${run.fromLabel}`
								: describePeerRunStatus(run)}
						</span>
						<Markdown text={run.answer} />
					</section>
				)}
			</div>
			<div className="sd-actions">
				<span className="sd-note">
					Only Read, Grep and Glob run here. {sessionLabel} kept working and never saw this.
				</span>
				<button type="button" className="btn sm" onClick={onClose}>
					Close
				</button>
			</div>
		</dialog>
	);
};
