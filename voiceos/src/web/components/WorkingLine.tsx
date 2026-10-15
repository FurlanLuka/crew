// The foot of a session's stream while its turn runs: three dots, what it is doing and for how long;
// red, like its tab, when it waits on you. Gone when it is done.
import { formatAge } from '../../state/working.js';
import { useNow } from '../use-now.js';
import type { WorkingLine as Line } from '../working-line.js';

const ELAPSED_TICK_MS = 1000;

export const WorkingLine = ({ line }: { line: NonNullable<Line> }) => {
	const now = useNow(ELAPSED_TICK_MS);

	if (line.kind === 'waiting') {
		return (
			<div className="line working waiting" role="status">
				<span className="dot ask" />
				<span>Waiting on you</span>
			</div>
		);
	}

	return (
		<div className="line working" role="status" aria-label={`working: ${line.what}`}>
			<span className="working-dots" aria-hidden="true">
				<i />
				<i />
				<i />
			</span>
			<span>{line.what}</span>
			{line.since !== null && (
				<span className="c-dim">{formatAge(Math.max(0, now - line.since))}</span>
			)}
		</div>
	);
};
