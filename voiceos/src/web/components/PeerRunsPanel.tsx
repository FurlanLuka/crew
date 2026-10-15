// Other sessions' asks and secret requests of this one, beside its sub-agents: a read-only copy
// answered them, or the machine copied a secret, while this session went on with its own work. A row
// stays a while after it ends; the asking session keeps the whole exchange.
import type { PeerRun } from '../../shared/protocol.js';
import { formatAge } from '../../state/working.js';
import { describePeerRunStatus, listShownRuns } from '../derive.js';
import { useNow } from '../use-now.js';
import { LockIcon } from './icons.js';

const ELAPSED_TICK_MS = 1000;

const DOT: Partial<Record<PeerRun['status'], string>> = {
	asking: 'running',
	waiting_ok: 'running',
	needs_work: 'running',
	answered: 'ok',
	queued: 'ok',
};

interface PeerRunsPanelProps {
	runs: PeerRun[];
	// Opens an ask's steps; a secret has none to show.
	onOpen: (requestId: string) => void;
}

export const PeerRunsPanel = ({ runs, onOpen }: PeerRunsPanelProps) => {
	const now = useNow(ELAPSED_TICK_MS);
	const shown = listShownRuns(runs, now);

	if (shown.length === 0) {
		return null;
	}

	return (
		<section className="panel" aria-label="asked by other sessions">
			<span className="lbl">asked by other sessions · {shown.length}</span>
			{[...shown].reverse().map((run) => {
				const status =
					run.settledAt === null && run.status === 'asking' && run.kind === 'ask'
						? formatAge(now - run.startedAt)
						: `${describePeerRunStatus(run)}${run.settledAt ? ` · ${formatAge(now - run.settledAt)}` : ''}`;
				const rows = (
					<>
						<div className="row">
							<i className={`dot ${DOT[run.status] ?? ''}`} />
							<span className="c-ink">{run.fromLabel}</span>
							<span className="el">{status}</span>
						</div>
						<div className="row c-dim">
							{run.kind === 'secret' ? (
								<>
									<LockIcon /> copy of {run.text}
								</>
							) : (
								run.text
							)}
						</div>
						{run.step && <div className="row c-dim step">▸ {run.step}</div>}
					</>
				);

				return run.kind === 'ask' ? (
					<button
						type="button"
						key={run.requestId}
						className="subagent"
						data-request={run.requestId}
						onClick={() => onOpen(run.requestId)}
					>
						{rows}
					</button>
				) : (
					<div key={run.requestId} className="subagent" data-request={run.requestId}>
						{rows}
					</div>
				);
			})}
		</section>
	);
};
