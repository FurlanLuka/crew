// One log beside the servers card's list, followed every 2 s and pinned to its end. Remounted
// (keyed) for each target, so another target's last reply is never shown under this one.
import type { SetupCommand } from '../../crew/commands.js';
import { isErrorLine } from '../components/DevLogsDialog.js';
import { useStickToBottom } from '../use-stick-to-bottom.js';
import { useCrew } from './api.js';
import { readLogText } from './readers.js';

const FOLLOW_MS = 2000;

interface LogPaneProps {
	machine: string;
	command: SetupCommand;
	title: string;
	onClose: () => void;
}

export const LogPane = ({ machine, command, title, onClose }: LogPaneProps) => {
	const log = useCrew<unknown>(machine, command, { pollMs: FOLLOW_MS });
	const text = readLogText(log.data);
	const lines = text ? text.split('\n') : [];
	const listRef = useStickToBottom<HTMLDivElement>(title);
	const failure = log.reply && !log.isLoading && !text ? log.reply.stderr.trim() : '';

	return (
		<section className="log-pane" aria-label={`${title} log`}>
			<div className="log-pane-head">
				<b>{title}</b>
				<span className="m">following</span>
				<button type="button" className="x" aria-label="Close the log" onClick={onClose}>
					×
				</button>
			</div>
			<div className="log-pane-lines" ref={listRef}>
				{lines.length === 0 && (
					<div className="c-dim">
						{failure || (log.isLoading ? 'Reading the log…' : 'Nothing logged yet.')}
					</div>
				)}
				{lines.map((line, index) => (
					// Lines repeat and have no ids: an index key costs only re-rendering the rows that shifted.
					<div key={index} className={isErrorLine(line) ? 'c-crit' : undefined}>
						{line}
					</div>
				))}
			</div>
		</section>
	);
};
