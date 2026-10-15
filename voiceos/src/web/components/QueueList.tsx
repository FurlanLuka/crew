import type { Session } from '../../shared/protocol.js';
import { describeCarried } from '../../state/attachments.js';
import type { Dispatch } from '../types.js';

interface QueueListProps {
	session: Session;
	dispatch: Dispatch;
}

export const QueueList = ({ session, dispatch }: QueueListProps) => {
	if (session.queue.length === 0) {
		return null;
	}

	return (
		<section className="queue" aria-label="queued">
			{session.queue.map((item, index) => (
				<div key={item.id} className="qitem">
					<span className="qtag">queued {index + 1}</span>{' '}
					{/* One flex item: who it is from reads as part of the line, never its own column. */}
					<span className="qtext">
						{item.from && <span className="c-amber">from {item.from.label} · </span>}
						{item.text}
						{item.attachments?.length ? (
							<span className="c-dim"> ·{describeCarried(item.attachments)}</span>
						) : null}
					</span>
					<button
						type="button"
						className="btn small"
						onClick={() =>
							dispatch({ type: 'promote_queued', ref: session.ref, queuedId: item.id })
						}
					>
						▲ now
					</button>
					<button
						type="button"
						className="btn small x"
						onClick={() => dispatch({ type: 'cancel_queued', ref: session.ref, queuedId: item.id })}
					>
						✕ cancel
					</button>
				</div>
			))}
		</section>
	);
};
