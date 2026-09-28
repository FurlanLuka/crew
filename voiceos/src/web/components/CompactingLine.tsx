import { formatAge } from '../../state/working.js';
import { useNow } from '../use-now.js';

const ELAPSED_TICK_MS = 1000;

interface CompactingLineProps {
	since: number;
}

export const CompactingLine = ({ since }: CompactingLineProps) => {
	// The SDK says when compaction starts and ends, never how far it is: a bar that moves, and the time.
	const now = useNow(ELAPSED_TICK_MS);

	return (
		<div className="line compacting" role="status" aria-label="compacting context">
			<span className="c-amber">Compacting context…</span>
			<span className="c-dim">{formatAge(Math.max(0, now - since))}</span>
			<div className="bar indeterminate">
				<i />
			</div>
		</div>
	);
};
