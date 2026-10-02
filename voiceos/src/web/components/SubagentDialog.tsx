import type { SubagentRun } from '../../shared/protocol.js';
import { describeRunStatus, splitRunReport } from '../derive.js';
import { useNow } from '../use-now.js';
import { useStickToBottom } from '../use-stick-to-bottom.js';
import { Markdown } from './Markdown.js';
import { StreamLine } from './StreamLine.js';

const ELAPSED_TICK_MS = 1000;

interface SubagentDialogProps {
	run: SubagentRun;
	isRunning: boolean;
	onClose: () => void;
}

// What a sub-agent said and did, filling in while it runs and kept once it ends. A real modal: Esc
// closes it (the dialog's own cancel), and the page's own Esc and Space leave it alone.
export const SubagentDialog = ({ run, isRunning, onClose }: SubagentDialogProps) => {
	const now = useNow(ELAPSED_TICK_MS);
	const listRef = useStickToBottom<HTMLDivElement>(run.taskId);
	const { lines, report } = splitRunReport(run, isRunning);

	return (
		<dialog
			className="sd"
			aria-label="sub-agent transcript"
			ref={(dialog) => {
				if (dialog && !dialog.open) {
					dialog.showModal();
				}
			}}
			onClose={onClose}
		>
			<div className="sd-head">
				<span className="sd-kicker">sub-agent</span>
				<h2>
					{run.agentType ?? 'agent'}{' '}
					<span className="sd-status">· {describeRunStatus(run, isRunning, now)}</span>
				</h2>
				<p className="sd-task">{run.description}</p>
			</div>
			<div className="sd-lines" ref={listRef}>
				{lines.length === 0 && report === null && <div className="line c-dim">Nothing yet.</div>}
				{lines.map((item) => (
					<StreamLine key={item.id} item={item} />
				))}
				{report !== null && (
					<section className="sd-report" aria-label="report">
						<span className="sd-kicker">report</span>
						<Markdown text={report} />
					</section>
				)}
			</div>
			<div className="sd-actions">
				<button type="button" className="btn sm" onClick={onClose}>
					Close
				</button>
			</div>
		</dialog>
	);
};
