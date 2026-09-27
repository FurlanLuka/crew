import type { Subagent } from '../../shared/protocol.js';
import { formatAge } from '../../state/working.js';
import { useNow } from '../use-now.js';

const ELAPSED_TICK_MS = 1000;

interface SubagentsPanelProps {
	subagents: Subagent[];
}

export const SubagentsPanel = ({ subagents }: SubagentsPanelProps) => {
	const now = useNow(ELAPSED_TICK_MS);

	if (subagents.length === 0) {
		return null;
	}

	return (
		<section className="panel" aria-label="sub-agents">
			<span className="lbl">sub-agents · {subagents.length}</span>
			{subagents.map((subagent) => (
				<div key={subagent.taskId} className="subagent" data-task={subagent.taskId}>
					<div className="row">
						<i className="dot running" />
						<span className="c-ink">{subagent.agentType ?? 'agent'}</span>
						<span className="el">{formatAge(now - subagent.startedAt)}</span>
					</div>
					<div className="row c-dim">
						{subagent.description}
						{subagent.isBackground ? ' · background' : ''}
					</div>
					{subagent.step && <div className="row c-dim step">▸ {subagent.step}</div>}
				</div>
			))}
		</section>
	);
};
