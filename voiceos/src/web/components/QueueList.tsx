import type { Session } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';

interface QueueListProps {
	session: Session;
	dispatch: Dispatch;
}

export const QueueList = ({ session, dispatch }: QueueListProps) => {
	if (session.queue.length === 0) {
		return <div />;
	}

	return (
		<section className="queue" aria-label="queued">
			{session.queue.map((item, index) => (
				<div key={item.id} className="qitem">
					<span className="c-cyan">queued {index + 1}</span> {item.text}
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
