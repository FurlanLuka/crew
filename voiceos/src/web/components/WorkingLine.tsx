// How a running turn shows it is at work: three soft dots and a clock. On a tool call's own line while
// it runs; at the foot of the stream for quiet thinking, or in red, like its tab, when it waits on
// you.
import { formatAge } from '../../state/working.js';
import { useNow } from '../use-now.js';

const ELAPSED_TICK_MS = 1000;

export const WorkingDots = () => (
	<span className="working-dots" aria-hidden="true">
		<i />
		<i />
		<i />
	</span>
);

export const WorkingClock = ({ since }: { since: number }) => {
	const now = useNow(ELAPSED_TICK_MS);

	return <span className="c-dim working-clock">{formatAge(Math.max(0, now - since))}</span>;
};

export const ThinkingLine = ({ since }: { since: number | null }) => (
	<div className="line working" role="status" aria-label="working: thinking">
		<WorkingDots />
		<span>Thinking</span>
		{since !== null && <WorkingClock since={since} />}
	</div>
);

export const WaitingLine = () => (
	<div className="line working waiting" role="status">
		<span className="dot ask" />
		<span>Waiting on you</span>
	</div>
);
